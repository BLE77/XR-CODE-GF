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
import {
  eventId,
  formatEventTime,
  payloadText,
  signalLabel,
  summarizeSignal,
  type AgentWireEvent,
  type CodingSessionSnapshot,
  type WireValue,
} from "./lib/protocol";
import { createYukiMotionEngine, type YukiMotionEngine, type YukiMotionState } from "./lib/yukiMotionEngine";
import {
  createYukiBehaviorPlannerState,
  planYukiBehavior,
  YUKI_AUTONOMOUS_SEAT_STABILITY,
  YUKI_AUTONOMOUS_TABLE_STABILITY,
  type YukiBehaviorPlannerState,
} from "./lib/yukiBehaviorPlanner";
import {
  createSpatialAffordanceStore,
  type SpatialAffordance,
  type SpatialAffordanceKind,
  type SpatialObjectObservation,
  type SpatialAffordanceStore,
  type SpatialSurfaceObservation,
} from "./lib/spatialAffordances";

const YUKI_ASSET_CANDIDATES = ["/vrms/Yuki.glb", "/vrms/Yuki.vrm"] as const;
const XR_VOICE_TOGGLE_EVENT = "xr-agent-voice-toggle-request";

type StageTone = "calm" | "working" | "attention" | "success";
type CharacterState = "idle" | "listening" | "working" | "alert" | "ready";
type AvatarMode = "idle" | "listening" | "thinking" | "speaking";
type AnimationState = YukiMotionState;
type AvatarLoadState = "loading" | "ready" | "fallback";
type XRState = "checking" | "ready" | "entering" | "active" | "unsupported" | "failed";
type AvatarClipState = "idle" | "listening" | "thinking" | "speaking" | "alert";
type XrDeckMode = "expanded" | "compact" | "hidden";
type XrDeckAnchor = "left" | "front" | "right";

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
  signalEvents: AgentWireEvent[];
  activityEvents: AgentWireEvent[];
  micAvailable: boolean;
  micActive: boolean;
  onToggleMic: () => void;
  onLiveContext?: (source: string, context: Record<string, unknown>) => void;
  leadSession?: CodingSessionSnapshot;
  sessions: CodingSessionSnapshot[];
};

type PanelCard = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
};

type XrPanelKey = "summary" | "worker" | "status";
const XR_PANEL_KEYS = ["summary", "worker", "status"] as const satisfies readonly XrPanelKey[];
type XrPanelHitZone = "content" | "move-bar" | "edge" | "corner" | "window-control";
type XrPanelDisplayMode = "open" | "minimized";
type XrNativeControlAction =
  | "place-yuki"
  | "use-seat"
  | "stand-table"
  | "toggle-mic"
  | "toggle-deck"
  | "toggle-panel-minimized"
  | "follow-anchor"
  | "next-worker"
  | "previous-worker";

type XrPanelHit = {
  key: XrPanelKey;
  canvasX: number;
  canvasY: number;
  localX: number;
  localY: number;
  distance: number;
  zone: XrPanelHitZone;
};

type XrPanelPointerKind = "select" | "squeeze" | "pinch";

type XrPanelDragEnd = {
  panel: XrPanelKey | null;
  clickAction: XrNativeControlAction | null;
  shouldClick: boolean;
};

type HermesChatMessage = {
  speaker: "user" | "hermes" | "worker";
  label: string;
  text: string;
};

type FallbackRig = {
  group: THREE.Group;
  head: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  body: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
};

type XRHandSpaceLike = THREE.Group & {
  joints?: Partial<Record<XRHandJoint, THREE.Object3D>>;
  inputState?: {
    pinching?: boolean;
  };
};

type XRControllerWithInputSource = THREE.Object3D & {
  userData: {
    inputSource?: XRInputSource;
    inputSourceConnectedAt?: number;
    inputSourceDisconnectedAt?: number;
    [key: string]: unknown;
  };
};

type WristMicControl = {
  group: THREE.Group;
  base: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  face: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  glow: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  hitTarget: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  raycaster: THREE.Raycaster;
  tempMatrix: THREE.Matrix4;
  tempPosition: THREE.Vector3;
  tempQuaternion: THREE.Quaternion;
  tempScale: THREE.Vector3;
  tempVector: THREE.Vector3;
  tempVectorB: THREE.Vector3;
  visualState: string;
  pressPulseUntil: number;
};

type XrPointerVisual = {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  cursor: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  hitPoint: THREE.Vector3;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  lastHit: XrPanelHit | null;
};

type XrInputDiagnosticSeverity = "info" | "active" | "warning";

type XrInputDiagnosticPanel = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  lastMessage: string;
  lastSeverity: XrInputDiagnosticSeverity | null;
  lastDrawAt: number;
};

type XrUiPlacementState = {
  targetPosition: THREE.Vector3;
  targetQuaternion: THREE.Quaternion;
  manualPosition: THREE.Vector3;
  manualQuaternion: THREE.Quaternion;
  cameraPosition: THREE.Vector3;
  cameraQuaternion: THREE.Quaternion;
  cameraForward: THREE.Vector3;
  cameraRight: THREE.Vector3;
  cameraEuler: THREE.Euler;
  yukiAnchorPosition: THREE.Vector3;
  yukiAnchorRight: THREE.Vector3;
  yukiAnchorToCamera: THREE.Vector3;
  sourcePosition: THREE.Vector3;
  sourceDirection: THREE.Vector3;
  sourceHitPosition: THREE.Vector3;
  dragOffset: THREE.Vector3;
  panelLocalPosition: THREE.Vector3;
  panelManualPlacement: Record<XrPanelKey, boolean>;
  panelManualPositions: Record<XrPanelKey, THREE.Vector3>;
  panelManualQuaternions: Record<XrPanelKey, THREE.Quaternion>;
  pendingSource: THREE.Object3D | null;
  pendingPanel: XrPanelKey | null;
  pendingPointerKind: XrPanelPointerKind | null;
  pendingClickAction: XrNativeControlAction | null;
  pendingStartedAt: number;
  pendingStartRayPoint: THREE.Vector3;
  pendingCurrentRayPoint: THREE.Vector3;
  pendingRayDistance: number;
  dragSource: THREE.Object3D | null;
  dragPanel: XrPanelKey | null;
  dragPointerKind: XrPanelPointerKind | null;
  dragClickAction: XrNativeControlAction | null;
  dragClickSuppressed: boolean;
  dragDistance: number;
  dragDistanceOffset: number;
  dragHeightOffset: number;
  dragStartedAt: number;
  dragStartPosition: THREE.Vector3;
  dragMoved: boolean;
  hoverPanel: XrPanelKey | null;
  hoverAction: XrNativeControlAction | null;
  hoverZone: XrPanelHitZone | null;
  lastPointerEventAt: number;
  lastPointerEventLabel: string;
  lastPointerMissAt: number;
  manualPlacement: boolean;
  recenterRequested: boolean;
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
  xrUiRoot: THREE.Group;
  xrUi: XrUiPlacementState;
  panels: {
    summary: PanelCard;
    worker: PanelCard;
    status: PanelCard;
  };
  wristMic: WristMicControl;
  leftHand: XRHandSpaceLike;
  rightHand: XRHandSpaceLike;
  leftGrip: THREE.Group;
  rightGrip: THREE.Group;
  leftController: THREE.Group;
  rightController: THREE.Group;
  leftPointer: XrPointerVisual;
  rightPointer: XrPointerVisual;
  xrDiagnostics: XrInputDiagnosticPanel;
  vrm: VRM | null;
  avatarScene: THREE.Object3D | null;
  avatarMode: LoadedAvatar["mode"] | null;
  avatarRig: AvatarRig | null;
  avatarAnimations: AvatarAnimationController | null;
  avatarMorphs: SceneMorphController | null;
  avatarGrounding: AvatarGroundingState;
  avatarPlacement: AvatarPlacementState;
  spatialAffordances: SpatialAffordanceStore;
  affordanceDebug: AffordanceDebugVisuals;
  spatialScan: SpatialScanState;
  spatialBehavior: YukiBehaviorPlannerState;
  motionEngine: YukiMotionEngine;
};

type PreviewLocomotionState = {
  keys: Set<string>;
  position: THREE.Vector3;
  defaultPosition: THREE.Vector3;
  iwerDefaultPosition: THREE.Vector3;
  iwerDefaultCaptured: boolean;
  yaw: number;
  pitch: number;
  defaultYaw: number;
  defaultPitch: number;
  iwerDefaultYaw: number;
  iwerDefaultPitch: number;
  resetRequested: boolean;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  move: THREE.Vector3;
  euler: THREE.Euler;
  quaternion: THREE.Quaternion;
};

type IwerVector3Like = {
  x: number;
  y: number;
  z: number;
  set?: (x: number, y: number, z: number) => unknown;
};

type IwerQuaternionLike = {
  x: number;
  y: number;
  z: number;
  w: number;
  set?: (x: number, y: number, z: number, w: number) => unknown;
};

type IwerDeviceLike = {
  position?: IwerVector3Like;
  quaternion?: IwerQuaternionLike;
  notifyStateChange?: () => void;
};

declare global {
  interface Window {
    __xrStageDebug?: {
      runtime: StageRuntime | null;
      xrState: XRState;
      avatarStatus: AvatarLoadState;
    };
    __xrAgentEnterXR?: () => void;
    IWER_DEVICE?: IwerDeviceLike;
  }

  interface WindowEventMap {
    "xr-agent-xr-status": CustomEvent<{
      state: XRState;
      label: string;
      summary: string;
      message: string;
      canRequest: boolean;
    }>;
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
  leftUpperLeg?: THREE.Bone;
  leftLowerLeg?: THREE.Bone;
  leftFoot?: THREE.Bone;
  leftToes?: THREE.Bone;
  rightShoulder?: THREE.Bone;
  rightUpperArm?: THREE.Bone;
  rightLowerArm?: THREE.Bone;
  rightHand?: THREE.Bone;
  rightUpperLeg?: THREE.Bone;
  rightLowerLeg?: THREE.Bone;
  rightFoot?: THREE.Bone;
  rightToes?: THREE.Bone;
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

type AvatarGroundingState = {
  bounds: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
  samplePosition: THREE.Vector3;
  leftFootTarget: THREE.Vector3;
  rightFootTarget: THREE.Vector3;
  leftFootWorld: THREE.Vector3;
  rightFootWorld: THREE.Vector3;
  hipWorld: THREE.Vector3;
  effectorWorld: THREE.Vector3;
  targetWorld: THREE.Vector3;
  jointWorld: THREE.Vector3;
  effectorDirection: THREE.Vector3;
  targetDirection: THREE.Vector3;
  parentQuaternion: THREE.Quaternion;
  parentQuaternionInverse: THREE.Quaternion;
  worldDelta: THREE.Quaternion;
  localDelta: THREE.Quaternion;
  identityQuaternion: THREE.Quaternion;
  smoothedLift: number;
  lastMeasuredMinY: number;
  footTargetsInitialized: boolean;
  lastPlacementAt: number;
};

type AvatarPlacementState = {
  hasUserPlacement: boolean;
  anchorPosition: THREE.Vector3;
  floorY: number;
  source: "manual" | "autonomous" | null;
  affordanceKind: SpatialAffordanceKind | null;
  affordanceId: string | null;
  reticle: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  floorPlane: THREE.Plane;
  ray: THREE.Ray;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  target: THREE.Vector3;
  fallbackForward: THREE.Vector3;
  placedAt: number;
};

type AvatarPlacementResult = {
  target: THREE.Vector3;
  surfaceTarget: THREE.Vector3;
  affordance: SpatialAffordance | null;
};

type AffordanceDebugVisuals = {
  group: THREE.Group;
  markers: Array<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>>;
};

type SpatialScanState = {
  startedAt: number;
  lastPlaneAt: number;
  planeObservations: number;
  lastObjectAt: number;
  objectBoxObservations: number;
};

type SpatialScanSummary = {
  status: "waiting" | "geometry" | "semantic";
  message: string;
  scannedSurfaceCount: number;
  floorCount: number;
  seatCount: number;
  tableCount: number;
  blockedCount: number;
  planeObservations: number;
  objectBoxObservations: number;
};

type XRPlaneLike = {
  planeSpace?: XRSpace;
  polygon?: DOMPointReadOnly[];
  orientation?: string;
  semanticLabel?: string;
  lastChangedTime?: number;
};

type XRFrameWithDetectedPlanes = XRFrame & {
  detectedPlanes?: Set<XRPlaneLike>;
};

const SCENE_BACKGROUND = 0x06111c;
const DESKTOP_SCENE_BACKGROUND = 0xf0f7ff;
const DESKTOP_SCENE_FOG = 0xe6f1ff;
const AVATAR_TARGET_HEIGHT = 1.23;
const AVATAR_BASE_FLOOR_CLEARANCE = 0.025;
const PREVIEW_AVATAR_FLOOR_LIFT = 0.065;
const DESKTOP_PREVIEW_AVATAR_FLOOR_LIFT = 0.075;
const ACTIVE_XR_AVATAR_SCALE_BOOST = 1.24;
const IWER_SIM_AVATAR_SCALE_BOOST = 0.88;
const ACTIVE_XR_AVATAR_FLOOR_LIFT = 0.045;
const IWER_SIM_AVATAR_FLOOR_LIFT = 0.62;
const AVATAR_GROUND_MAX_LIFT = 0.36;
const AVATAR_GROUND_MAX_DROP = 0.22;
const AVATAR_IK_MAX_FOOT_TARGET_DRIFT = 0.42;
const YUKI_HAIR_COLOR = new THREE.Color(0x030304);
const YUKI_HAIR_SHADE_COLOR = new THREE.Color(0x000000);
const ACTIVE_XR_ASSISTANT_SIDE_X = -0.62;
const AVATAR_PLACEMENT_DEFAULT_DISTANCE = 1.35;
const AVATAR_PLACEMENT_MAX_DISTANCE = 3.2;
const AVATAR_PLACEMENT_RETICLE_LIFT = 0.012;
const AFFORDANCE_DEBUG_MAX_MARKERS = 10;
const IWER_SIM_STAGE_DEPTH = -1.92;
const ACTIVE_XR_STAGE_DEPTH = -1.52;
const STAGE_DEPTH = -1.92;
const PANEL_DEPTH = -2.18;
const ASSISTANT_BASE_Y = 0.18;
const WRIST_MIC_ON = 0x57f0b7;
const WRIST_MIC_OFF = 0x7dd3fc;
const WRIST_MIC_UNAVAILABLE = 0x9aa8bb;
const WRIST_MIC_RAY_DISTANCE = 2.5;
const WRIST_MIC_TOUCH_RADIUS = 0.2;
const XR_UI_DISTANCE = 1.72;
const XR_UI_MIN_DISTANCE = 0.86;
const XR_UI_MAX_DISTANCE = 2.85;
const XR_UI_HEIGHT_OFFSET = 0.04;
const XR_UI_MIN_HEIGHT = 1.08;
const XR_UI_MAX_HEIGHT = 1.62;
const XR_UI_EXPANDED_SCALE = 1;
const XR_UI_COMPACT_SCALE = 0.82;
const XR_UI_HIDDEN_SCALE = 0.72;
const XR_PANEL_MINIMIZED_SCALE = 0.34;
const XR_UI_YUKI_SIDE_OFFSET = 0.95;
const XR_UI_YUKI_BEHIND_OFFSET = 0.62;
const XR_UI_YUKI_MIN_HEIGHT_OVER_ROOT = 1.08;
const XR_UI_SIDE_PANEL_X = 1.18;
const XR_UI_SIDE_PANEL_Y = -0.42;
const XR_UI_CENTER_PANEL_Y = 0.2;
const XR_UI_STATUS_Y = -0.56;
const XR_UI_PANEL_TOUCH_RADIUS = 0.14;
const XR_UI_DRAG_THUMBSTICK_SPEED = 0.62;
const XR_UI_TAP_MOVE_THRESHOLD = 0.045;
const XR_UI_PINCH_HOLD_DRAG_MS = 320;
const XR_UI_PINCH_DRAG_RAY_THRESHOLD = 0.055;
const XR_UI_MISSED_HIT_DIAGNOSTIC_MS = 1400;
const XR_POINTER_DEFAULT_LENGTH = 1.85;
const XR_POINTER_VISUALS_ENABLED = true;
const XR_PANEL_WINDOW_CONTROL_SIZE = 54;
const XR_PANEL_WINDOW_CONTROL_TOP = 48;
const XR_PANEL_WINDOW_CONTROL_RIGHT = 52;
const XR_PANEL_MOVE_BAR_TOP = 48;
const XR_PANEL_MOVE_BAR_WIDTH = 340;
const XR_PANEL_MOVE_BAR_HEIGHT = 48;
const XR_PANEL_EDGE_GRAB_SIZE = 58;
const XR_PANEL_CORNER_GRAB_SIZE = 96;
const XR_PANEL_ORDER: XrPanelKey[] = ["summary", "worker", "status"];
const XR_STATUS_CONTROL_ZONES: Array<{
  action: XrNativeControlAction;
  x: number;
  y: number;
  width: number;
  height: number;
}> = [
  { action: "place-yuki", x: 48, y: 208, width: 222, height: 50 },
  { action: "use-seat", x: 286, y: 208, width: 222, height: 50 },
  { action: "stand-table", x: 524, y: 208, width: 222, height: 50 },
  { action: "toggle-mic", x: 762, y: 208, width: 214, height: 50 },
  { action: "follow-anchor", x: 48, y: 270, width: 222, height: 50 },
  { action: "next-worker", x: 286, y: 270, width: 222, height: 50 },
  { action: "previous-worker", x: 524, y: 270, width: 222, height: 50 },
];
const XR_JOYSTICK_AXIS_THRESHOLD = 0.55;
const XR_JOYSTICK_AXIS_RELEASE = 0.26;
const XR_JOYSTICK_REPEAT_MS = 240;
const PREVIEW_WALK_SPEED = 1.25;
const PREVIEW_FAST_SPEED = 2.8;
const PREVIEW_VERTICAL_SPEED = 0.85;
const PREVIEW_TURN_SPEED = 1.6;
const PREVIEW_CONTROL_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "KeyE",
  "KeyR",
  "KeyP",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "KeyC",
  "PageUp",
  "PageDown",
  "ShiftLeft",
  "ShiftRight",
]);
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
  cameraPosition: new THREE.Vector3(0, 1.34, 1.3),
  cameraLookAt: new THREE.Vector3(0, 1.04, -0.72),
  assistantZ: -1.42,
  assistantY: 0.78,
  avatarZOffset: 0.04,
  avatarScaleBoost: 0.92,
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
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(scale[0], scale[1]), material);
  mesh.position.copy(position);
  mesh.rotation.y = rotationY;
  mesh.renderOrder = 30;

  return { canvas, context, texture, mesh };
}

function createXrInputDiagnosticPanel(): XrInputDiagnosticPanel {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create XR input diagnostic canvas context.");
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.18), material);
  mesh.name = "xr-input-diagnostic-panel";
  mesh.position.set(0, -0.92, 0.08);
  mesh.renderOrder = 86;
  mesh.visible = false;

  return {
    canvas,
    context,
    texture,
    mesh,
    lastMessage: "",
    lastSeverity: null,
    lastDrawAt: 0,
  };
}

function createXrUiPlacementState(): XrUiPlacementState {
  return {
    targetPosition: new THREE.Vector3(),
    targetQuaternion: new THREE.Quaternion(),
    manualPosition: new THREE.Vector3(),
    manualQuaternion: new THREE.Quaternion(),
    cameraPosition: new THREE.Vector3(),
    cameraQuaternion: new THREE.Quaternion(),
    cameraForward: new THREE.Vector3(),
    cameraRight: new THREE.Vector3(1, 0, 0),
    cameraEuler: new THREE.Euler(0, 0, 0, "YXZ"),
    yukiAnchorPosition: new THREE.Vector3(),
    yukiAnchorRight: new THREE.Vector3(1, 0, 0),
    yukiAnchorToCamera: new THREE.Vector3(0, 0, 1),
    sourcePosition: new THREE.Vector3(),
    sourceDirection: new THREE.Vector3(0, 0, -1),
    sourceHitPosition: new THREE.Vector3(),
    dragOffset: new THREE.Vector3(),
    panelLocalPosition: new THREE.Vector3(),
    panelManualPlacement: {
      summary: false,
      worker: false,
      status: false,
    },
    panelManualPositions: {
      summary: new THREE.Vector3(),
      worker: new THREE.Vector3(),
      status: new THREE.Vector3(),
    },
    panelManualQuaternions: {
      summary: new THREE.Quaternion(),
      worker: new THREE.Quaternion(),
      status: new THREE.Quaternion(),
    },
    pendingSource: null,
    pendingPanel: null,
    pendingPointerKind: null,
    pendingClickAction: null,
    pendingStartedAt: 0,
    pendingStartRayPoint: new THREE.Vector3(),
    pendingCurrentRayPoint: new THREE.Vector3(),
    pendingRayDistance: XR_UI_DISTANCE,
    dragSource: null,
    dragPanel: null,
    dragPointerKind: null,
    dragClickAction: null,
    dragClickSuppressed: false,
    dragDistance: XR_UI_DISTANCE,
    dragDistanceOffset: 0,
    dragHeightOffset: 0,
    dragStartedAt: 0,
    dragStartPosition: new THREE.Vector3(),
    dragMoved: false,
    hoverPanel: null,
    hoverAction: null,
    hoverZone: null,
    lastPointerEventAt: 0,
    lastPointerEventLabel: "",
    lastPointerMissAt: 0,
    manualPlacement: false,
    recenterRequested: true,
  };
}

function createWristMicControl(): WristMicControl {
  const group = new THREE.Group();
  group.name = "wrist-mic-control";

  const base = new THREE.Mesh(
    new THREE.CircleGeometry(0.076, 64),
    new THREE.MeshStandardMaterial({
      color: 0x06131f,
      emissive: 0x0f3044,
      emissiveIntensity: 0.14,
      transparent: true,
      opacity: 0.56,
      roughness: 0.42,
      metalness: 0.24,
      side: THREE.DoubleSide,
    }),
  );
  base.position.z = 0.008;
  group.add(base);

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create wrist mic canvas context.");
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.078, 24, 24),
    new THREE.MeshBasicMaterial({
      color: WRIST_MIC_UNAVAILABLE,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.scale.z = 0.08;
  glow.position.z = -0.004;
  group.add(glow);

  const face = new THREE.Mesh(
    new THREE.CircleGeometry(0.061, 64),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    }),
  );
  face.position.z = 0.016;
  group.add(face);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.067, 0.0036, 12, 96),
    new THREE.MeshStandardMaterial({
      color: WRIST_MIC_UNAVAILABLE,
      emissive: WRIST_MIC_UNAVAILABLE,
      emissiveIntensity: 0.7,
      transparent: true,
      opacity: 0.9,
      roughness: 0.32,
      metalness: 0.1,
    }),
  );
  ring.position.z = 0.02;
  group.add(ring);

  const hitTarget = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.28, 0.16),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  hitTarget.name = "wrist-mic-hit-target";
  hitTarget.position.z = 0.02;
  group.add(hitTarget);

  const control: WristMicControl = {
    group,
    base,
    face,
    ring,
    glow,
    hitTarget,
    canvas,
    context,
    texture,
    raycaster: new THREE.Raycaster(),
    tempMatrix: new THREE.Matrix4(),
    tempPosition: new THREE.Vector3(),
    tempQuaternion: new THREE.Quaternion(),
    tempScale: new THREE.Vector3(),
    tempVector: new THREE.Vector3(),
    tempVectorB: new THREE.Vector3(),
    visualState: "",
    pressPulseUntil: 0,
  };
  drawWristMicFace(control, false, false);
  return control;
}

function createXrPointerVisual(name: string): XrPointerVisual {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
    }),
  );
  line.name = `${name}-ray`;
  line.renderOrder = 80;
  line.visible = false;

  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.028, 0.042, 48),
    new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    }),
  );
  cursor.name = `${name}-cursor`;
  cursor.renderOrder = 82;
  cursor.visible = false;

  return {
    line,
    cursor,
    hitPoint: new THREE.Vector3(),
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, -1),
    lastHit: null,
  };
}

function drawWristMicFace(control: WristMicControl, micAvailable: boolean, micActive: boolean) {
  const { canvas, context, texture } = control;
  const accent = micAvailable ? (micActive ? "#5df2b6" : "#7dd3fc") : "#8c9aaa";
  const status = micAvailable ? (micActive ? "LIVE" : "TAP") : "SETUP";

  context.clearRect(0, 0, canvas.width, canvas.height);
  const background = context.createRadialGradient(210, 164, 28, 256, 256, 246);
  background.addColorStop(0, micActive ? "rgba(93, 242, 182, 0.34)" : "rgba(125, 211, 252, 0.18)");
  background.addColorStop(0.48, "rgba(15, 34, 50, 0.94)");
  background.addColorStop(1, "rgba(3, 10, 18, 0.98)");
  context.fillStyle = background;
  context.beginPath();
  context.arc(256, 256, 240, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = "rgba(255, 255, 255, 0.34)";
  context.lineWidth = 4;
  context.beginPath();
  context.arc(256, 256, 222, Math.PI * 1.18, Math.PI * 1.48);
  context.stroke();

  context.strokeStyle = "rgba(238, 250, 255, 0.18)";
  context.lineWidth = 8;
  context.beginPath();
  context.arc(256, 256, 226, 0, Math.PI * 2);
  context.stroke();

  context.shadowColor = accent;
  context.shadowBlur = micActive ? 24 : 14;
  context.fillStyle = accent;
  context.beginPath();
  context.arc(380, 138, 22, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;

  context.strokeStyle = accent;
  context.lineWidth = 18;
  context.lineCap = "round";
  context.lineJoin = "round";
  roundRect(context, 214, 116, 84, 130, 40);
  context.stroke();

  context.strokeStyle = "rgba(241, 250, 255, 0.86)";
  context.lineWidth = 10;
  context.beginPath();
  context.moveTo(256, 136);
  context.lineTo(256, 224);
  context.stroke();

  context.strokeStyle = accent;
  context.lineWidth = 18;
  context.beginPath();
  context.moveTo(176, 214);
  context.bezierCurveTo(176, 300, 336, 300, 336, 214);
  context.stroke();

  context.beginPath();
  context.moveTo(256, 302);
  context.lineTo(256, 350);
  context.moveTo(218, 356);
  context.lineTo(294, 356);
  context.stroke();

  context.fillStyle = "rgba(255, 255, 255, 0.08)";
  context.beginPath();
  context.arc(256, 256, 154, 0, Math.PI * 2);
  context.fill();

  context.textAlign = "center";
  context.fillStyle = accent;
  context.font = "900 54px Inter, system-ui, sans-serif";
  context.fillText(status, 256, 444);

  context.fillStyle = "rgba(236, 248, 255, 0.74)";
  context.font = "700 24px Inter, system-ui, sans-serif";
  context.fillText("VOICE", 256, 480);
  texture.needsUpdate = true;
}

function updateWristMicVisual(
  control: WristMicControl,
  micAvailable: boolean,
  micActive: boolean,
  elapsed: number,
) {
  const stateKey = `${micAvailable ? "available" : "unavailable"}-${micActive ? "on" : "off"}`;
  if (control.visualState !== stateKey) {
    control.visualState = stateKey;
    drawWristMicFace(control, micAvailable, micActive);
  }

  const color = micAvailable ? (micActive ? WRIST_MIC_ON : WRIST_MIC_OFF) : WRIST_MIC_UNAVAILABLE;
  const pulse = micActive ? Math.max(0, Math.sin(elapsed * 5.2)) : 0;
  const pressPulse = performance.now() < control.pressPulseUntil ? 1 : 0;
  control.ring.material.color.setHex(color);
  control.ring.material.emissive.setHex(color);
  control.ring.material.emissiveIntensity = micAvailable ? 0.7 + pulse * 0.42 + pressPulse * 0.8 : 0.38;
  control.ring.material.opacity = micAvailable ? 0.88 + pulse * 0.1 : 0.52;
  control.ring.scale.setScalar(1 + pulse * 0.055 + pressPulse * 0.12);

  control.glow.material.color.setHex(color);
  control.glow.material.opacity = micAvailable ? (micActive ? 0.17 + pulse * 0.12 : 0.08 + pressPulse * 0.14) : 0.035;
  control.glow.scale.set(1 + pulse * 0.18 + pressPulse * 0.26, 1 + pulse * 0.18 + pressPulse * 0.26, 0.08);

  control.base.material.emissive.setHex(color);
  control.base.material.emissiveIntensity = micAvailable ? 0.12 + pulse * 0.12 + pressPulse * 0.32 : 0.04;
  control.face.material.opacity = micAvailable ? 1 : 0.7;
}

function updateWristMicPlacement(runtime: StageRuntime, activeXrSession: boolean) {
  const control = runtime.wristMic;
  runtime.camera.updateMatrixWorld(true);
  if (activeXrSession) {
    const leftHand = xrHandSpaceForHand(runtime, "left");
    const wristJoint = leftHand?.joints?.wrist;
    const leftGrip = xrGripForHand(runtime, "left");
    const leftController = xrTrackedControllerForHand(runtime, "left");
    const anchor = wristJoint ?? leftGrip ?? leftController;

    if (anchor) {
      anchor.updateMatrixWorld(true);
      control.tempVector.set(
        wristJoint ? 0.018 : -0.055,
        wristJoint ? 0.018 : -0.035,
        wristJoint ? -0.026 : -0.075,
      );
      control.group.position.copy(control.tempVector).applyMatrix4(anchor.matrixWorld);
      runtime.camera.getWorldPosition(control.tempVectorB);
      control.group.lookAt(control.tempVectorB);
      control.group.scale.setScalar(wristJoint ? 0.34 : 0.38);
      control.group.visible = true;
      return;
    }

    control.tempVector.set(-0.34, -0.18, -0.72);
    control.group.position.copy(control.tempVector).applyMatrix4(runtime.camera.matrixWorld);
    runtime.camera.getWorldQuaternion(control.group.quaternion);
    control.group.scale.setScalar(0.36);
    control.group.visible = true;
    return;
  }
  control.group.visible = true;

  const narrowPreview = runtime.camera.aspect < 0.75;
  control.tempVector.set(
    narrowPreview ? -0.035 : -0.38,
    narrowPreview ? -0.12 : -0.08,
    narrowPreview ? -0.72 : -0.82,
  );
  control.group.position.copy(control.tempVector).applyMatrix4(runtime.camera.matrixWorld);
  runtime.camera.getWorldQuaternion(control.group.quaternion);
  control.group.scale.setScalar(narrowPreview ? 0.42 : 0.36);
}

function sourceTouchesWristMic(control: WristMicControl, source: THREE.Object3D, radius = WRIST_MIC_TOUCH_RADIUS) {
  source.updateMatrixWorld(true);
  control.group.updateMatrixWorld(true);
  control.hitTarget.updateMatrixWorld(true);
  source.getWorldPosition(control.tempVector);
  control.hitTarget.getWorldPosition(control.tempVectorB);
  return control.tempVector.distanceTo(control.tempVectorB) <= radius;
}

function sourceRayHitsWristMic(control: WristMicControl, source: THREE.Object3D) {
  source.updateMatrixWorld(true);
  control.group.updateMatrixWorld(true);
  control.tempMatrix.identity().extractRotation(source.matrixWorld);
  control.raycaster.ray.origin.setFromMatrixPosition(source.matrixWorld);
  control.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(control.tempMatrix).normalize();
  control.raycaster.near = 0;
  control.raycaster.far = WRIST_MIC_RAY_DISTANCE;
  return control.raycaster.intersectObject(control.hitTarget, false).length > 0;
}

function handTouchesWristMic(control: WristMicControl, hand: XRHandSpaceLike) {
  const indexTip =
    hand.joints?.["index-finger-tip"] ??
    hand.joints?.["index-finger-phalanx-distal"] ??
    hand.joints?.["index-finger-phalanx-intermediate"];
  return indexTip ? sourceTouchesWristMic(control, indexTip, WRIST_MIC_TOUCH_RADIUS) : sourceTouchesWristMic(control, hand);
}

function affordanceColor(kind: SpatialAffordanceKind) {
  switch (kind) {
    case "seat":
      return 0x5df2b6;
    case "table":
      return 0xffc46b;
    case "floor":
      return 0x7dd3fc;
    default:
      return 0xff8068;
  }
}

function createAffordanceDebugVisuals(): AffordanceDebugVisuals {
  const group = new THREE.Group();
  group.name = "spatial-affordance-debug";
  group.visible = false;
  const markers = Array.from({ length: AFFORDANCE_DEBUG_MAX_MARKERS }, (_, index) => {
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.2, 64),
      new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    marker.name = `spatial-affordance-marker-${index}`;
    marker.rotation.x = -Math.PI / 2;
    marker.renderOrder = 13;
    marker.visible = false;
    group.add(marker);
    return marker;
  });
  return { group, markers };
}

function createSpatialScanState(): SpatialScanState {
  return {
    startedAt: performance.now() / 1000,
    lastPlaneAt: Number.NEGATIVE_INFINITY,
    planeObservations: 0,
    lastObjectAt: Number.NEGATIVE_INFINITY,
    objectBoxObservations: 0,
  };
}

function createAvatarPlacementState(): AvatarPlacementState {
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.24, 0.265, 96),
    new THREE.MeshBasicMaterial({
      color: 0x5df2b6,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  reticle.name = "yuki-placement-reticle";
  reticle.rotation.x = -Math.PI / 2;
  reticle.renderOrder = 14;
  reticle.visible = false;

  return {
    hasUserPlacement: false,
    anchorPosition: new THREE.Vector3(),
    floorY: 0,
    source: null,
    affordanceKind: null,
    affordanceId: null,
    reticle,
    floorPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    ray: new THREE.Ray(),
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    target: new THREE.Vector3(),
    fallbackForward: new THREE.Vector3(0, 0, -1),
    placedAt: 0,
  };
}

function resolveAvatarPlacementTarget(
  placement: AvatarPlacementState,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
) {
  placement.direction.copy(direction);
  if (placement.direction.lengthSq() < 0.0001) {
    placement.direction.set(0, -0.24, -1);
  }
  placement.direction.normalize();
  placement.floorPlane.setComponents(0, 1, 0, 0);
  placement.ray.set(origin, placement.direction);

  const floorHit = placement.ray.intersectPlane(placement.floorPlane, placement.target);
  const hitDistance = floorHit ? floorHit.distanceTo(origin) : Number.POSITIVE_INFINITY;
  if (floorHit && hitDistance >= 0.35 && hitDistance <= AVATAR_PLACEMENT_MAX_DISTANCE) {
    return placement.target.clone();
  }

  placement.fallbackForward.copy(placement.direction);
  placement.fallbackForward.y = 0;
  if (placement.fallbackForward.lengthSq() < 0.0001) {
    placement.fallbackForward.set(0, 0, -1);
  }
  placement.fallbackForward.normalize();
  return placement.target
    .copy(origin)
    .addScaledVector(placement.fallbackForward, AVATAR_PLACEMENT_DEFAULT_DISTANCE)
    .setY(0)
    .clone();
}

function resolveAffordancePlacementTarget(
  runtime: StageRuntime,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
) {
  const targeted = runtime.spatialAffordances.nearestRayHit(origin, direction);
  if (targeted && targeted.kind !== "blocked") {
    return targeted;
  }
  return null;
}

function avatarAnchorForSurface(target: THREE.Vector3, affordance?: SpatialAffordance | null) {
  const anchor = target.clone();
  if (affordance?.kind !== "seat") {
    anchor.y = 0;
  }
  return anchor;
}

function applyAvatarPlacement(
  runtime: StageRuntime,
  target: THREE.Vector3,
  options: {
    source?: AvatarPlacementState["source"];
    affordance?: SpatialAffordance | null;
  } = {},
) {
  const placement = runtime.avatarPlacement;
  const anchor = avatarAnchorForSurface(target, options.affordance);
  placement.hasUserPlacement = true;
  placement.anchorPosition.copy(anchor);
  placement.floorY = 0;
  placement.source = options.source ?? "manual";
  placement.affordanceKind = options.affordance?.kind ?? null;
  placement.affordanceId = options.affordance?.id ?? null;
  placement.placedAt = performance.now();
  placement.reticle.position.set(target.x, target.y + AVATAR_PLACEMENT_RETICLE_LIFT, target.z);
  placement.reticle.material.color.setHex(
    options.affordance?.kind ? affordanceColor(options.affordance.kind) : affordanceColor("floor"),
  );
  placement.reticle.visible = true;
  runtime.spatialAffordances.observeSurface(
    {
      id: `manual:${placement.source}:${target.x.toFixed(2)}:${target.y.toFixed(2)}:${target.z.toFixed(2)}`,
      center: target,
      normal: new THREE.Vector3(0, 1, 0),
      width: options.affordance?.size.x ?? 0.72,
      depth: options.affordance?.size.z ?? 0.72,
      source: "manual",
      timestamp: performance.now() / 1000,
      confidence: options.source === "autonomous" ? 0.82 : 0.74,
      label: options.affordance?.label ?? options.affordance?.kind ?? "manual placement",
    },
    0,
  );
}

function placeAvatarFromCamera(runtime: StageRuntime) {
  runtime.camera.updateMatrixWorld(true);
  runtime.camera.getWorldPosition(runtime.avatarPlacement.origin);
  runtime.camera.getWorldDirection(runtime.avatarPlacement.direction);
  const affordance = resolveAffordancePlacementTarget(
    runtime,
    runtime.avatarPlacement.origin,
    runtime.avatarPlacement.direction,
  );
  const target = affordance?.center.clone() ?? resolveAvatarPlacementTarget(
    runtime.avatarPlacement,
    runtime.avatarPlacement.origin,
    runtime.avatarPlacement.direction,
  );
  applyAvatarPlacement(runtime, target, { source: "manual", affordance });
  return { target: avatarAnchorForSurface(target, affordance), surfaceTarget: target, affordance };
}

function placeAvatarFromSource(runtime: StageRuntime, source: THREE.Object3D) {
  source.updateMatrixWorld(true);
  runtime.avatarPlacement.origin.setFromMatrixPosition(source.matrixWorld);
  runtime.avatarPlacement.direction.set(0, 0, -1).transformDirection(source.matrixWorld);
  const affordance = resolveAffordancePlacementTarget(
    runtime,
    runtime.avatarPlacement.origin,
    runtime.avatarPlacement.direction,
  );
  const target = affordance?.center.clone() ?? resolveAvatarPlacementTarget(
    runtime.avatarPlacement,
    runtime.avatarPlacement.origin,
    runtime.avatarPlacement.direction,
  );
  applyAvatarPlacement(runtime, target, { source: "manual", affordance });
  return { target: avatarAnchorForSurface(target, affordance), surfaceTarget: target, affordance };
}

function placementSummary(result: AvatarPlacementResult) {
  const surface = result.affordance;
  const target = result.surfaceTarget;
  const location = `${target.x.toFixed(1)}m x, ${Math.abs(target.z).toFixed(1)}m from stage origin`;
  if (!surface) {
    return `Yuki placed on a floor target at ${location}. No scanned seat or table was under the ray.`;
  }
  if (surface.kind === "seat") {
    return `Yuki placed on scanned ${surface.label ?? "seat"} at ${location}. She will use it as a seat.`;
  }
  if (surface.kind === "table") {
    return `Yuki is standing on the floor near scanned ${surface.label ?? "table"} at ${location}.`;
  }
  if (surface.kind === "floor") {
    return `Yuki placed on scanned floor at ${location}.`;
  }
  return `Yuki target is blocked near ${location}; choose a clearer surface.`;
}

function updateAffordanceDebugVisuals(runtime: StageRuntime) {
  const candidates = runtime.spatialAffordances.list().slice(0, runtime.affordanceDebug.markers.length);
  runtime.affordanceDebug.group.visible = stageDebugEnabled();
  runtime.affordanceDebug.markers.forEach((marker, index) => {
    const candidate = candidates[index];
    if (!candidate || candidate.kind === "blocked") {
      marker.visible = false;
      return;
    }
    marker.visible = true;
    marker.position.set(candidate.center.x, candidate.center.y + 0.016, candidate.center.z);
    marker.scale.set(
      THREE.MathUtils.clamp(candidate.size.x / 0.42, 0.55, 3.2),
      THREE.MathUtils.clamp(candidate.size.z / 0.42, 0.55, 3.2),
      1,
    );
    marker.material.color.setHex(affordanceColor(candidate.kind));
    marker.material.opacity = THREE.MathUtils.clamp(0.18 + candidate.stability * 0.58, 0.18, 0.78);
  });
}

function stableAffordanceCount(
  runtime: StageRuntime,
  kind: SpatialAffordanceKind,
  minStability: number,
  includeStage = false,
) {
  return runtime.spatialAffordances
    .list(kind)
    .filter((candidate) => (includeStage || candidate.source !== "stage") && candidate.stability >= minStability)
    .length;
}

function spatialScanSummary(runtime: StageRuntime): SpatialScanSummary {
  const floorCount = stableAffordanceCount(runtime, "floor", 0.62);
  const seatCount = stableAffordanceCount(runtime, "seat", YUKI_AUTONOMOUS_SEAT_STABILITY);
  const tableCount = stableAffordanceCount(runtime, "table", YUKI_AUTONOMOUS_TABLE_STABILITY);
  const blockedCount = stableAffordanceCount(runtime, "blocked", 0.5);
  const scannedSurfaceCount = floorCount + seatCount + tableCount + blockedCount;
  const semanticActive = runtime.spatialScan.objectBoxObservations > 0;
  const geometryActive = runtime.spatialScan.planeObservations > 0 || scannedSurfaceCount > 0;
  const status: SpatialScanSummary["status"] = semanticActive ? "semantic" : geometryActive ? "geometry" : "waiting";
  const message =
    status === "semantic"
      ? `Scene-aware: ${runtime.spatialScan.objectBoxObservations} object boxes, ${seatCount} seats, ${tableCount} tables.`
      : status === "geometry"
        ? `Geometry scan: ${runtime.spatialScan.planeObservations} planes, ${seatCount} seat-like surfaces, ${tableCount} tables.`
        : "Room scan warming up. Enter XR and look slowly across the floor, chair, and desk.";

  return {
    status,
    message,
    scannedSurfaceCount,
    floorCount,
    seatCount,
    tableCount,
    blockedCount,
    planeObservations: runtime.spatialScan.planeObservations,
    objectBoxObservations: runtime.spatialScan.objectBoxObservations,
  };
}

function observeDetectedXrPlanes(runtime: StageRuntime, frame: XRFrame | undefined, elapsed: number) {
  const detectedPlanes = (frame as XRFrameWithDetectedPlanes | undefined)?.detectedPlanes;
  if (!detectedPlanes?.size) {
    return;
  }

  const referenceSpace = (
    runtime.renderer.xr as THREE.WebXRManager & {
      getReferenceSpace?: () => XRReferenceSpace | null;
    }
  ).getReferenceSpace?.();
  if (!referenceSpace) {
    return;
  }

  detectedPlanes.forEach((plane) => {
    if (!plane.planeSpace || !plane.polygon || plane.polygon.length < 3) {
      return;
    }
    const pose = frame?.getPose(plane.planeSpace, referenceSpace);
    if (!pose) {
      return;
    }

    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const bounds = new THREE.Box3();
    plane.polygon.forEach((point) => {
      bounds.expandByPoint(new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix));
    });
    if (bounds.isEmpty()) {
      return;
    }

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bounds.getCenter(center);
    bounds.getSize(size);
    const normal = new THREE.Vector3(0, 1, 0).transformDirection(matrix);
    if (normal.y < 0) {
      normal.multiplyScalar(-1);
    }

    const observation: SpatialSurfaceObservation = {
      id: plane.lastChangedTime
        ? `xr-plane:${plane.lastChangedTime.toFixed(0)}`
        : `xr-plane:${center.x.toFixed(1)}:${center.y.toFixed(1)}:${center.z.toFixed(1)}`,
      center,
      normal,
      width: Math.max(size.x, 0.02),
      depth: Math.max(size.z, 0.02),
      source: "xr-plane",
      timestamp: elapsed,
      confidence: plane.orientation === "horizontal" ? 0.88 : 0.64,
      label: plane.semanticLabel,
    };
    runtime.spatialAffordances.observeSurface(observation, 0);
    runtime.spatialScan.planeObservations += 1;
    runtime.spatialScan.lastPlaneAt = elapsed;
  });
}

function updateSpatialAffordances(
  runtime: StageRuntime,
  frame: XRFrame | undefined,
  elapsed: number,
  desktopPreviewActive: boolean,
) {
  runtime.spatialAffordances.update(elapsed);
  runtime.spatialAffordances.seedFloor(new THREE.Vector3(0, 0, 0), 3.4, 3.4, elapsed, "stage");
  observeDetectedXrPlanes(runtime, frame, elapsed);

  if (desktopPreviewActive && stageDebugEnabled()) {
    runtime.spatialAffordances.observeSurface(
      {
        id: "synthetic:debug-seat",
        center: new THREE.Vector3(0.44, 0.42, -1.12),
        normal: new THREE.Vector3(0, 1, 0),
        width: 0.78,
        depth: 0.52,
        source: "synthetic",
        timestamp: elapsed,
        confidence: 0.72,
        label: "debug low surface",
      },
      0,
    );
  }

  updateAffordanceDebugVisuals(runtime);
}

const SPATIAL_OBJECT_EVENT_TYPES = new Set([
  "xr.object_box",
  "xr.object_boxes",
  "xr.scene.object_box",
  "xr.scene.object_boxes",
  "spatial.object_box",
  "spatial.object_boxes",
]);

function wireRecord(value: WireValue | undefined): Record<string, WireValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function wireArray(value: WireValue | undefined): WireValue[] | null {
  return Array.isArray(value) ? value : null;
}

function wireNumber(value: WireValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function wireString(value: WireValue | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function firstWireNumber(record: Record<string, WireValue>, keys: string[]) {
  for (const key of keys) {
    const value = wireNumber(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function firstWireString(record: Record<string, WireValue>, keys: string[]) {
  for (const key of keys) {
    const value = wireString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function vectorFromWireRecord(
  record: Record<string, WireValue>,
  objectKey: string,
  xKeys: string[],
  yKeys: string[],
  zKeys: string[],
) {
  const vectorRecord = wireRecord(record[objectKey]);
  const x = vectorRecord ? wireNumber(vectorRecord.x) : firstWireNumber(record, xKeys);
  const y = vectorRecord ? wireNumber(vectorRecord.y) : firstWireNumber(record, yKeys);
  const z = vectorRecord ? wireNumber(vectorRecord.z) : firstWireNumber(record, zKeys);
  if (x === null || y === null || z === null) {
    return null;
  }
  return new THREE.Vector3(x, y, z);
}

function spatialObjectObservationFromRecord(
  record: Record<string, WireValue>,
  timestamp: number,
): SpatialObjectObservation | null {
  const className = firstWireString(record, ["className", "class_name", "label", "name", "category"]);
  if (!className) {
    return null;
  }
  const center = vectorFromWireRecord(
    record,
    "center",
    ["center_x", "x"],
    ["center_y", "y"],
    ["center_z", "z"],
  );
  const size =
    vectorFromWireRecord(record, "size", ["size_x", "width"], ["size_y", "height"], ["size_z", "depth"]) ??
    vectorFromWireRecord(record, "extent", ["extent_x", "width"], ["extent_y", "height"], ["extent_z", "depth"]);
  if (!center || !size) {
    return null;
  }
  return {
    id: firstWireString(record, ["id", "object_id", "track_id"]),
    className,
    center,
    size,
    yaw: firstWireNumber(record, ["yaw"]) ?? undefined,
    timestamp,
    confidence: firstWireNumber(record, ["confidence", "score"]) ?? undefined,
    source: "object-box",
  };
}

function spatialObjectRecordsFromEvent(event: AgentWireEvent): Record<string, WireValue>[] {
  if (!SPATIAL_OBJECT_EVENT_TYPES.has(event.type)) {
    return [];
  }
  const objectList = wireArray(event.payload.objects) ?? wireArray(event.payload.boxes);
  if (objectList) {
    return objectList.flatMap((entry) => {
      const record = wireRecord(entry);
      return record ? [record] : [];
    });
  }
  return [event.payload];
}

function ingestSpatialObjectEvents(
  runtime: StageRuntime,
  events: AgentWireEvent[],
  seenEventIds: Set<string>,
) {
  for (const event of events) {
    const records = spatialObjectRecordsFromEvent(event);
    if (records.length === 0) {
      continue;
    }
    const id = eventId(event);
    if (seenEventIds.has(id)) {
      continue;
    }
    seenEventIds.add(id);
    const parsedTs = Date.parse(event.ts);
    const timestamp = Number.isFinite(parsedTs) ? parsedTs / 1000 : performance.now() / 1000;
    records.forEach((record) => {
      const observation = spatialObjectObservationFromRecord(record, timestamp);
      if (observation) {
        runtime.spatialAffordances.observeObjectBox(observation, 0);
        runtime.spatialScan.objectBoxObservations += 1;
        runtime.spatialScan.lastObjectAt = timestamp;
      }
    });
  }
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
  let current = "";
  for (const rawWord of words) {
    let word = rawWord;
    while (context.measureText(word).width > maxWidth && word.length > 4) {
      let cut = word.length - 1;
      while (cut > 3 && context.measureText(`${word.slice(0, cut)}-`).width > maxWidth) {
        cut -= 1;
      }
      lines.push(`${word.slice(0, Math.max(cut, 3))}-`);
      word = word.slice(Math.max(cut, 3));
    }
    if (!current) {
      current = word;
      continue;
    }
    const candidate = `${current} ${word}`;
    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function ellipsizeLine(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const cleaned = text.trim();
  if (context.measureText(cleaned).width <= maxWidth) {
    return cleaned;
  }

  let candidate = cleaned;
  while (candidate.length > 1 && context.measureText(`${candidate.trimEnd()}...`).width > maxWidth) {
    candidate = candidate.slice(0, -1);
  }
  return `${candidate.trimEnd()}...`;
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number,
  lineHeight: number,
) {
  const wrapped = wrapLines(context, text, maxWidth);
  const lines = wrapped.slice(0, maxLines);
  if (wrapped.length > maxLines && lines.length > 0) {
    lines[lines.length - 1] = ellipsizeLine(context, lines[lines.length - 1], maxWidth);
  }
  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight);
  });
  return lines.length;
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
  background.addColorStop(0, "rgba(252, 247, 255, 0.96)");
  background.addColorStop(0.48, "rgba(238, 247, 255, 0.92)");
  background.addColorStop(1, "rgba(218, 234, 255, 0.88)");
  context.fillStyle = background;
  roundRect(context, 20, 20, width - 40, height - 40, 36);
  context.fill();

  context.strokeStyle = "rgba(61, 126, 255, 0.2)";
  context.lineWidth = 3;
  roundRect(context, 20, 20, width - 40, height - 40, 36);
  context.stroke();

  context.fillStyle = "rgba(255, 255, 255, 0.52)";
  roundRect(context, 36, 36, width - 72, height - 72, 28);
  context.fill();

  context.save();
  roundRect(context, 38, 38, width - 76, height - 76, 26);
  context.clip();

  context.fillStyle = accent;
  roundRect(context, 44, 48, 190, 46, 23);
  context.fill();

  context.fillStyle = "#f9fcff";
  context.font = "800 22px Inter, system-ui, sans-serif";
  context.fillText(eyebrow.toUpperCase(), 66, 78);

  context.fillStyle = "#08215f";
  const titleLength = title.trim().length;
  const titleFontSize = titleLength > 34 ? 34 : titleLength > 22 ? 38 : 44;
  context.font = `800 ${titleFontSize}px Inter, system-ui, sans-serif`;
  const titleLines = wrapLines(context, title, width - 88).slice(0, 2);
  if (titleLines.length > 1) {
    titleLines[1] = ellipsizeLine(context, titleLines[1], width - 88);
  }
  titleLines.forEach((line, index) => {
    context.fillText(line, 44, 152 + index * (titleFontSize + 8));
  });

  context.fillStyle = "rgba(29, 57, 112, 0.84)";
  const bodyLength = body.trim().length;
  const bodyFontSize = bodyLength > 420 ? 20 : bodyLength > 300 ? 22 : bodyLength > 210 ? 24 : 27;
  const lineHeight = bodyFontSize + 7;
  const maxLines = Math.max(5, Math.floor((height - 342) / lineHeight));
  context.font = `500 ${bodyFontSize}px Inter, system-ui, sans-serif`;
  drawWrappedText(context, body, 44, 250, width - 88, maxLines, lineHeight);

  context.fillStyle = "rgba(43, 111, 255, 0.76)";
  context.font = "800 22px Inter, system-ui, sans-serif";
  context.fillText(
    ellipsizeLine(context, "Trigger tap: click", width - 88),
    44,
    height - 72,
  );
  context.fillText(
    ellipsizeLine(context, "Grab rail, edge, or corner: move panel", width - 88),
    44,
    height - 42,
  );

  context.restore();
  texture.needsUpdate = true;
}

function drawChatPanel(
  panel: PanelCard,
  messages: HermesChatMessage[],
  {
    tone,
    compact,
    scrollOffset = 0,
  }: {
    tone: StageTone;
    compact: boolean;
    scrollOffset?: number;
  },
) {
  const { canvas, context, texture } = panel;
  const width = canvas.width;
  const height = canvas.height;
  const accent = `#${toneColor(tone).toString(16).padStart(6, "0")}`;

  context.clearRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "rgba(255, 252, 244, 0.98)");
  background.addColorStop(0.58, "rgba(240, 249, 255, 0.95)");
  background.addColorStop(1, "rgba(225, 240, 255, 0.92)");
  context.fillStyle = background;
  roundRect(context, 20, 20, width - 40, height - 40, 38);
  context.fill();

  context.strokeStyle = "rgba(43, 111, 255, 0.22)";
  context.lineWidth = 3;
  roundRect(context, 20, 20, width - 40, height - 40, 38);
  context.stroke();

  context.fillStyle = "rgba(255, 255, 255, 0.58)";
  roundRect(context, 36, 36, width - 72, height - 72, 30);
  context.fill();

  context.save();
  roundRect(context, 38, 38, width - 76, height - 76, 28);
  context.clip();

  context.fillStyle = accent;
  roundRect(context, 48, 48, 232, 48, 24);
  context.fill();
  context.fillStyle = "#f9fcff";
  context.font = "900 22px Inter, system-ui, sans-serif";
  context.fillText("HERMES CHAT", 70, 80);

  context.fillStyle = "#08215f";
  context.font = `900 ${compact ? 37 : 42}px Inter, system-ui, sans-serif`;
  context.fillText(ellipsizeLine(context, "Hermes conversation", width - 96), 48, 150);

  const visibleCount = compact ? 2 : 4;
  const maxScroll = Math.max(0, messages.length - visibleCount);
  const clampedScroll = THREE.MathUtils.clamp(scrollOffset, 0, maxScroll);
  const startIndex = Math.max(0, messages.length - visibleCount - clampedScroll);
  const visibleMessages = messages.slice(startIndex, startIndex + visibleCount);
  let cursorY = compact ? 218 : 202;
  const maxBubbleWidth = compact ? width - 118 : width - 128;
  visibleMessages.forEach((message) => {
    const isUser = message.speaker === "user";
    const isWorker = message.speaker === "worker";
    const bubbleX = isUser ? width - maxBubbleWidth - 52 : 52;
    const bubbleColor = isUser
      ? "rgba(43, 111, 255, 0.13)"
      : isWorker
        ? "rgba(255, 177, 76, 0.18)"
        : "rgba(90, 240, 186, 0.16)";
    const textColor = "#173162";
    const labelColor = isUser ? "#245dd8" : isWorker ? "#b45f00" : "#087f62";
    const maxLines = compact ? 2 : 3;
    const fontSize = compact ? 24 : 25;
    const lineHeight = fontSize + 8;

    context.font = `700 20px Inter, system-ui, sans-serif`;
    context.fillStyle = labelColor;
    const label = ellipsizeLine(context, message.label.toUpperCase(), maxBubbleWidth - 40);
    const bodyLines = wrapLines(context, message.text, maxBubbleWidth - 40).slice(0, maxLines);
    if (bodyLines.length === maxLines) {
      bodyLines[bodyLines.length - 1] = ellipsizeLine(context, bodyLines[bodyLines.length - 1], maxBubbleWidth - 40);
    }
    const bubbleHeight = 58 + Math.max(1, bodyLines.length) * lineHeight;

    if (cursorY + bubbleHeight > height - 126) {
      return;
    }

    context.fillStyle = bubbleColor;
    roundRect(context, bubbleX, cursorY, maxBubbleWidth, bubbleHeight, 28);
    context.fill();
    context.strokeStyle = isUser ? "rgba(43, 111, 255, 0.18)" : "rgba(22, 163, 121, 0.16)";
    context.lineWidth = 2;
    roundRect(context, bubbleX, cursorY, maxBubbleWidth, bubbleHeight, 28);
    context.stroke();

    context.fillStyle = labelColor;
    context.font = "800 19px Inter, system-ui, sans-serif";
    context.fillText(label, bubbleX + 22, cursorY + 34);

    context.fillStyle = textColor;
    context.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    bodyLines.forEach((line, index) => {
      context.fillText(line, bubbleX + 22, cursorY + 70 + index * lineHeight);
    });

    cursorY += bubbleHeight + 16;
  });

  context.fillStyle = "rgba(43, 111, 255, 0.76)";
  context.font = "900 22px Inter, system-ui, sans-serif";
  const footer = compact
    ? "Left stick chooses panel  •  right stick scrolls"
    : `Chat ${startIndex + 1}-${Math.min(messages.length, startIndex + visibleCount)} / ${messages.length}: right stick scrolls`;
  context.fillText(ellipsizeLine(context, footer, width - 96), 48, height - 70);
  context.fillText(
    ellipsizeLine(context, "Trigger clicks. Grab rail, edge, or corner moves this panel.", width - 96),
    48,
    height - 40,
  );
  context.restore();
  texture.needsUpdate = true;
}

function sessionDisplayName(session: CodingSessionSnapshot | undefined) {
  return session?.workerLabel ?? session?.title ?? "No active session";
}

function buildSessionStreamLines(session: CodingSessionSnapshot | undefined): string[] {
  if (!session) {
    return [
      "No Claude/Codex/Kimi session is active yet.",
      "Launch a worker and its command, terminal screen, and status stream will appear here.",
    ];
  }

  const lines = [
    `$ ${session.command ?? "Hermes-managed session"}`,
    `repo: ${session.repoPath ?? "current project"} | status: ${normalizeWorkerStatus(session)}`,
  ];
  const statusLines = [
    session.pendingQuestion ? `question: ${session.pendingQuestion}` : null,
    session.blockedReason ? `blocked: ${session.blockedReason}` : null,
    session.statusText ? `status: ${session.statusText}` : null,
    session.managerSummary ? `summary: ${session.managerSummary}` : null,
    session.lastUpdate ? `update: ${session.lastUpdate}` : null,
  ].filter((line): line is string => Boolean(line));

  if (statusLines.length > 0) {
    lines.push("", ...statusLines);
  }

  const screenLines = session.screenText
    ?.split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-28);
  const outputTail = session.outputTail.map((line) => line.trimEnd()).filter(Boolean).slice(-28);
  const streamLines = screenLines?.length ? screenLines : outputTail;
  if (streamLines.length > 0) {
    lines.push("", "live stream:", ...streamLines);
  }

  return lines;
}

function drawTerminalPanel(
  panel: PanelCard,
  session: CodingSessionSnapshot | undefined,
  {
    tone,
    scrollOffset,
    focusLabel,
  }: {
    tone: StageTone;
    scrollOffset: number;
    focusLabel: string;
  },
) {
  const { canvas, context, texture } = panel;
  const width = canvas.width;
  const height = canvas.height;
  const accent = `#${toneColor(tone).toString(16).padStart(6, "0")}`;
  const title = sessionDisplayName(session);
  const subtitle = compactText(session?.taskTitle ?? session?.intent ?? session?.statusText, "Claude/Codex/Kimi session stream", 82);
  const lines = buildSessionStreamLines(session);

  context.clearRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "rgba(5, 12, 20, 0.99)");
  background.addColorStop(1, "rgba(9, 21, 34, 0.97)");
  context.fillStyle = background;
  roundRect(context, 20, 20, width - 40, height - 40, 38);
  context.fill();

  context.strokeStyle = "rgba(125, 211, 252, 0.32)";
  context.lineWidth = 3;
  roundRect(context, 20, 20, width - 40, height - 40, 38);
  context.stroke();

  context.save();
  roundRect(context, 38, 38, width - 76, height - 76, 28);
  context.clip();

  context.fillStyle = "rgba(255, 255, 255, 0.05)";
  roundRect(context, 38, 38, width - 76, height - 76, 28);
  context.fill();

  context.fillStyle = accent;
  roundRect(context, 52, 52, 198, 46, 23);
  context.fill();
  context.fillStyle = "#f9fcff";
  context.font = "900 22px Inter, system-ui, sans-serif";
  context.fillText("HERMES WORK", 72, 82);

  context.fillStyle = "#e8f8ff";
  context.font = "900 42px Inter, system-ui, sans-serif";
  context.fillText(ellipsizeLine(context, title, width - 104), 52, 154);

  context.fillStyle = "rgba(198, 229, 247, 0.84)";
  context.font = "700 23px Inter, system-ui, sans-serif";
  context.fillText(ellipsizeLine(context, subtitle, width - 104), 52, 196);

  const terminalTop = 226;
  const terminalBottom = height - 112;
  const lineHeight = 24;
  const maxLines = Math.floor((terminalBottom - terminalTop) / lineHeight);
  context.font = "700 18px SF Mono, Menlo, Consolas, monospace";
  const displayLines = lines.flatMap((line) => {
    if (!line) {
      return [""];
    }
    return wrapLines(context, line, width - 128);
  });
  const clampedScroll = THREE.MathUtils.clamp(scrollOffset, 0, Math.max(0, displayLines.length - maxLines));
  const end = Math.max(0, displayLines.length - clampedScroll);
  const start = Math.max(0, end - maxLines);
  const visibleLines = displayLines.slice(start, end);

  context.fillStyle = "rgba(0, 0, 0, 0.42)";
  roundRect(context, 48, terminalTop - 14, width - 96, terminalBottom - terminalTop + 28, 22);
  context.fill();

  visibleLines.forEach((line, index) => {
    const isMeta = line.startsWith("$") || line.startsWith("repo:") || line.endsWith(":");
    context.fillStyle = isMeta ? "#7dffca" : "rgba(228, 242, 252, 0.92)";
    context.fillText(ellipsizeLine(context, line, width - 128), 66, terminalTop + index * lineHeight);
  });

  context.fillStyle = "rgba(125, 211, 252, 0.84)";
  context.font = "900 21px Inter, system-ui, sans-serif";
  const scrollLabel =
    displayLines.length > maxLines ? `lines ${start + 1}-${end} / ${displayLines.length}` : `${displayLines.length} lines`;
  context.fillText(
    ellipsizeLine(
      context,
      `${focusLabel}  •  left stick focus  •  right stick scroll  •  ${scrollLabel}`,
      width - 104,
    ),
    52,
    height - 68,
  );
  context.fillText(
    ellipsizeLine(context, "Trigger clicks. Grab rail, edge, or corner moves this panel.", width - 104),
    52,
    height - 38,
  );

  context.restore();
  texture.needsUpdate = true;
}

function xrNativeControlLabel(
  action: XrNativeControlAction,
  scanSummary: SpatialScanSummary,
  deckMode: XrDeckMode,
  deckAnchor: XrDeckAnchor,
  micAvailable: boolean,
  micActive: boolean,
) {
  switch (action) {
    case "place-yuki":
      return "Place Yuki";
    case "use-seat":
      return scanSummary.seatCount > 0 ? `Seat ${scanSummary.seatCount}` : "Seat none";
    case "stand-table":
      return scanSummary.tableCount > 0 ? `Table ${scanSummary.tableCount}` : "Table none";
    case "toggle-mic":
      return !micAvailable ? "Mic setup" : micActive ? "Mic off" : "Mic on";
    case "toggle-deck":
      return deckMode === "expanded" ? "Minimize" : deckMode === "compact" ? "Hide" : "Show";
    case "toggle-panel-minimized":
      return "Panel";
    case "follow-anchor":
      return `Follow ${nextXrDeckAnchorValue(deckAnchor)}`;
    case "next-worker":
      return "Next";
    case "previous-worker":
      return "Previous";
  }
}

function drawXrNativeControlZones(
  context: CanvasRenderingContext2D,
  scanSummary: SpatialScanSummary,
  deckMode: XrDeckMode,
  deckAnchor: XrDeckAnchor,
  micAvailable: boolean,
  micActive: boolean,
) {
  context.save();
  context.font = "900 18px Inter, system-ui, sans-serif";
  XR_STATUS_CONTROL_ZONES.forEach((zone) => {
    const unavailable =
      (zone.action === "use-seat" && scanSummary.seatCount <= 0) ||
      (zone.action === "stand-table" && scanSummary.tableCount <= 0);
    context.fillStyle = unavailable ? "rgba(148, 163, 184, 0.18)" : "rgba(125, 211, 252, 0.16)";
    roundRect(context, zone.x, zone.y, zone.width, zone.height, 16);
    context.fill();
    context.strokeStyle = unavailable ? "rgba(148, 163, 184, 0.34)" : "rgba(125, 211, 252, 0.48)";
    context.lineWidth = 2;
    roundRect(context, zone.x, zone.y, zone.width, zone.height, 16);
    context.stroke();
    context.fillStyle = unavailable ? "rgba(203, 213, 225, 0.68)" : "#e8f8ff";
    const label = xrNativeControlLabel(zone.action, scanSummary, deckMode, deckAnchor, micAvailable, micActive);
    context.fillText(ellipsizeLine(context, label, zone.width - 28), zone.x + 14, zone.y + 32);
  });
  context.restore();
}

function drawActivityPanel(
  panel: PanelCard,
  {
    leadSession,
    sessions,
    activityEvents,
    tone,
    scanSummary,
    deckMode,
    deckAnchor,
    micAvailable,
    micActive,
  }: {
    leadSession: CodingSessionSnapshot | undefined;
    sessions: CodingSessionSnapshot[];
    activityEvents: AgentWireEvent[];
    tone: StageTone;
    scanSummary: SpatialScanSummary;
    deckMode: XrDeckMode;
    deckAnchor: XrDeckAnchor;
    micAvailable: boolean;
    micActive: boolean;
  },
) {
  const { canvas, context, texture } = panel;
  const width = canvas.width;
  const height = canvas.height;
  const accent = `#${toneColor(tone).toString(16).padStart(6, "0")}`;
  const rows = buildActivityRows(leadSession, sessions, activityEvents);
  const liveCount = sessions.filter((session) => session.status === "running" || session.status === "starting").length;

  context.clearRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "rgba(7, 18, 29, 0.98)");
  background.addColorStop(0.64, "rgba(13, 31, 45, 0.96)");
  background.addColorStop(1, "rgba(20, 39, 52, 0.94)");
  context.fillStyle = background;
  roundRect(context, 20, 20, width - 40, height - 40, 38);
  context.fill();

  context.strokeStyle = "rgba(125, 211, 252, 0.28)";
  context.lineWidth = 3;
  roundRect(context, 20, 20, width - 40, height - 40, 38);
  context.stroke();

  context.save();
  roundRect(context, 38, 38, width - 76, height - 76, 28);
  context.clip();

  context.fillStyle = accent;
  roundRect(context, 48, 48, 222, 48, 24);
  context.fill();
  context.fillStyle = "#f9fcff";
  context.font = "900 21px Inter, system-ui, sans-serif";
  context.fillText("AGENT ACTIVITY", 68, 80);

  context.fillStyle = "#e8f8ff";
  context.font = "900 37px Inter, system-ui, sans-serif";
  context.fillText(
    ellipsizeLine(context, `${liveCount} live / ${sessions.length} known`, width - 96),
    48,
    148,
  );

  context.fillStyle = "rgba(198, 229, 247, 0.82)";
  context.font = "700 21px Inter, system-ui, sans-serif";
  context.fillText(
    ellipsizeLine(context, scanSummary.message, width - 96),
    48,
    184,
  );

  drawXrNativeControlZones(context, scanSummary, deckMode, deckAnchor, micAvailable, micActive);

  let cursorY = 342;
  const rowHeight = 82;
  const maxRows = Math.max(2, Math.floor((height - 444) / rowHeight));
  const visibleRows = rows.slice(0, maxRows);
  if (visibleRows.length === 0) {
    context.fillStyle = "rgba(125, 211, 252, 0.12)";
    roundRect(context, 48, cursorY, width - 96, 112, 24);
    context.fill();
    context.fillStyle = "#d9f2ff";
    context.font = "800 24px Inter, system-ui, sans-serif";
    context.fillText("No managed agents visible yet.", 68, cursorY + 42);
    context.font = "600 21px Inter, system-ui, sans-serif";
    drawWrappedText(
      context,
      "When Hermes opens Claude, Codex, or Kimi, this panel will show the worker label, command, status, and latest terminal evidence.",
      68,
      cursorY + 76,
      width - 136,
      2,
      27,
    );
  } else {
    visibleRows.forEach((row) => {
      context.fillStyle = "rgba(255, 255, 255, 0.055)";
      roundRect(context, 48, cursorY, width - 96, rowHeight - 10, 22);
      context.fill();
      context.strokeStyle = "rgba(125, 211, 252, 0.14)";
      context.lineWidth = 2;
      roundRect(context, 48, cursorY, width - 96, rowHeight - 10, 22);
      context.stroke();

      context.fillStyle = "#7dffca";
      context.font = "900 21px Inter, system-ui, sans-serif";
      context.fillText(ellipsizeLine(context, row.label, width - 136), 68, cursorY + 30);

      context.fillStyle = "rgba(228, 242, 252, 0.9)";
      context.font = "650 20px Inter, system-ui, sans-serif";
      drawWrappedText(context, row.detail, 68, cursorY + 60, width - 136, 1, 25);
      cursorY += rowHeight;
    });
  }

  const newestEvent = activityEvents.find((event) => event.session_id || event.type.startsWith("terminal."));
  const footer = newestEvent
    ? `Newest event: ${agentActivityEventLine(newestEvent)}`
    : "Use left stick for panel focus. Use right stick here for worker focus.";
  context.fillStyle = "rgba(125, 211, 252, 0.84)";
  context.font = "900 20px Inter, system-ui, sans-serif";
  context.fillText(ellipsizeLine(context, footer, width - 96), 48, height - 70);
  context.fillText(
    ellipsizeLine(context, "Trigger clicks buttons. Grab rail, edge, or corner moves panel.", width - 96),
    48,
    height - 40,
  );

  context.restore();
  texture.needsUpdate = true;
}

function xrPanelFocusLabel(panel: XrPanelKey): string {
  switch (panel) {
    case "summary":
      return "Hermes chat";
    case "worker":
      return "Worker stream";
    case "status":
      return "Agent activity";
  }
}

function drawPanelFocusFrame(panel: PanelCard, selected: boolean) {
  if (!selected) {
    return;
  }
  const { canvas, context, texture } = panel;
  const width = canvas.width;
  const height = canvas.height;

  context.save();
  context.strokeStyle = "rgba(87, 240, 183, 0.95)";
  context.lineWidth = 10;
  roundRect(context, 24, 24, width - 48, height - 48, 38);
  context.stroke();
  context.restore();
  texture.needsUpdate = true;
}

function xrPanelRectContains(
  rect: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function xrPanelMoveBarRect(panel: PanelCard) {
  return {
    x: (panel.canvas.width - XR_PANEL_MOVE_BAR_WIDTH) / 2,
    y: XR_PANEL_MOVE_BAR_TOP,
    width: XR_PANEL_MOVE_BAR_WIDTH,
    height: XR_PANEL_MOVE_BAR_HEIGHT,
  };
}

function xrPanelWindowControlRect(panel: PanelCard) {
  return {
    x: panel.canvas.width - XR_PANEL_WINDOW_CONTROL_RIGHT - XR_PANEL_WINDOW_CONTROL_SIZE,
    y: XR_PANEL_WINDOW_CONTROL_TOP,
    width: XR_PANEL_WINDOW_CONTROL_SIZE,
    height: XR_PANEL_WINDOW_CONTROL_SIZE,
  };
}

function xrPanelHitZoneAt(panel: PanelCard, canvasX: number, canvasY: number): XrPanelHitZone {
  if (xrPanelRectContains(xrPanelWindowControlRect(panel), canvasX, canvasY)) {
    return "window-control";
  }
  if (xrPanelRectContains(xrPanelMoveBarRect(panel), canvasX, canvasY)) {
    return "move-bar";
  }

  const width = panel.canvas.width;
  const height = panel.canvas.height;
  const nearLeft = canvasX <= XR_PANEL_EDGE_GRAB_SIZE;
  const nearRight = canvasX >= width - XR_PANEL_EDGE_GRAB_SIZE;
  const nearTop = canvasY <= XR_PANEL_EDGE_GRAB_SIZE;
  const nearBottom = canvasY >= height - XR_PANEL_EDGE_GRAB_SIZE;
  const inLeftCorner = canvasX <= XR_PANEL_CORNER_GRAB_SIZE;
  const inRightCorner = canvasX >= width - XR_PANEL_CORNER_GRAB_SIZE;
  const inTopCorner = canvasY <= XR_PANEL_CORNER_GRAB_SIZE;
  const inBottomCorner = canvasY >= height - XR_PANEL_CORNER_GRAB_SIZE;

  if ((inLeftCorner || inRightCorner) && (inTopCorner || inBottomCorner)) {
    return "corner";
  }
  if (nearLeft || nearRight || nearTop || nearBottom) {
    return "edge";
  }
  return "content";
}

function xrPanelHitCanMovePanel(hit: XrPanelHit | null): boolean {
  return hit?.zone === "move-bar" || hit?.zone === "edge" || hit?.zone === "corner";
}

function drawXrPanelWindowControl(panel: PanelCard, minimized: boolean) {
  const { context, texture } = panel;
  const rect = xrPanelWindowControlRect(panel);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const radius = rect.width / 2;

  context.save();
  context.fillStyle = minimized ? "rgba(87, 240, 183, 0.9)" : "rgba(5, 16, 29, 0.72)";
  context.strokeStyle = minimized ? "rgba(5, 34, 42, 0.48)" : "rgba(255, 255, 255, 0.58)";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.strokeStyle = minimized ? "#05222a" : "#f9fcff";
  context.lineWidth = 6;
  context.lineCap = "round";
  if (!minimized) {
    context.beginPath();
    context.moveTo(centerX - 13, centerY);
    context.lineTo(centerX + 13, centerY);
    context.stroke();
  } else {
    context.strokeRect(centerX - 12, centerY - 12, 24, 24);
    context.beginPath();
    context.moveTo(centerX - 4, centerY - 12);
    context.lineTo(centerX + 12, centerY - 12);
    context.lineTo(centerX + 12, centerY + 4);
    context.stroke();
  }
  context.restore();
  texture.needsUpdate = true;
}

function drawXrPanelChrome(panel: PanelCard, panelKey: XrPanelKey, selected: boolean, minimized: boolean) {
  const { canvas, context, texture } = panel;
  const width = canvas.width;
  const height = canvas.height;
  const moveRect = xrPanelMoveBarRect(panel);
  const edgeColor = selected ? "rgba(87, 240, 183, 0.74)" : "rgba(5, 16, 29, 0.26)";
  const edgeGlow = selected ? "rgba(87, 240, 183, 0.18)" : "rgba(125, 211, 252, 0.14)";
  const railFill = selected ? "rgba(5, 16, 29, 0.82)" : "rgba(5, 16, 29, 0.58)";

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  context.strokeStyle = edgeGlow;
  context.lineWidth = 16;
  roundRect(context, 26, 26, width - 52, height - 52, 34);
  context.stroke();

  context.strokeStyle = edgeColor;
  context.lineWidth = selected ? 6 : 4;
  const cornerInset = 34;
  const cornerLength = 70;
  [
    [cornerInset, cornerInset, cornerInset + cornerLength, cornerInset, cornerInset, cornerInset + cornerLength],
    [
      width - cornerInset,
      cornerInset,
      width - cornerInset - cornerLength,
      cornerInset,
      width - cornerInset,
      cornerInset + cornerLength,
    ],
    [
      cornerInset,
      height - cornerInset,
      cornerInset + cornerLength,
      height - cornerInset,
      cornerInset,
      height - cornerInset - cornerLength,
    ],
    [
      width - cornerInset,
      height - cornerInset,
      width - cornerInset - cornerLength,
      height - cornerInset,
      width - cornerInset,
      height - cornerInset - cornerLength,
    ],
  ].forEach(([x1, y1, x2, y2, x3, y3]) => {
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.moveTo(x1, y1);
    context.lineTo(x3, y3);
    context.stroke();
  });

  context.fillStyle = railFill;
  context.strokeStyle = selected ? "rgba(87, 240, 183, 0.92)" : "rgba(255, 255, 255, 0.5)";
  context.lineWidth = 3;
  roundRect(context, moveRect.x, moveRect.y, moveRect.width, moveRect.height, moveRect.height / 2);
  context.fill();
  context.stroke();

  const gripStartX = moveRect.x + 38;
  const gripStartY = moveRect.y + 16;
  context.fillStyle = selected ? "#57f0b7" : "#d7edf8";
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 2; row += 1) {
      context.beginPath();
      context.arc(gripStartX + column * 14, gripStartY + row * 16, 4, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.fillStyle = "#f9fcff";
  context.font = "900 18px Inter, system-ui, sans-serif";
  const chromeLabel = ellipsizeLine(context, xrPanelFocusLabel(panelKey).toUpperCase(), moveRect.width - 128);
  context.fillText(chromeLabel, moveRect.x + 116, moveRect.y + 31);
  context.restore();

  drawXrPanelWindowControl(panel, minimized);
  texture.needsUpdate = true;
}

function drawXrPanelMinimizedHud(panel: PanelCard, panelKey: XrPanelKey, selected: boolean) {
  const { canvas, context, texture } = panel;
  const width = canvas.width;
  const height = canvas.height;

  context.clearRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "rgba(5, 16, 29, 0.96)");
  background.addColorStop(1, "rgba(14, 44, 67, 0.94)");
  context.fillStyle = background;
  roundRect(context, 40, 64, width - 80, height - 128, 54);
  context.fill();

  context.strokeStyle = selected ? "rgba(87, 240, 183, 0.92)" : "rgba(125, 211, 252, 0.52)";
  context.lineWidth = selected ? 10 : 6;
  roundRect(context, 40, 64, width - 80, height - 128, 54);
  context.stroke();

  context.fillStyle = selected ? "#57f0b7" : "#7dd3fc";
  context.font = "900 34px Inter, system-ui, sans-serif";
  context.fillText("MINIMIZED", 86, 150);

  context.fillStyle = "#f9fcff";
  context.font = "900 68px Inter, system-ui, sans-serif";
  context.fillText(ellipsizeLine(context, xrPanelFocusLabel(panelKey), width - 172), 86, 260);

  context.fillStyle = "rgba(228, 242, 252, 0.78)";
  context.font = "800 28px Inter, system-ui, sans-serif";
  context.fillText("Trigger the corner button to restore", 86, height - 138);
  context.fillText("Grab rail, edge, or corner to move", 86, height - 96);

  drawXrPanelWindowControl(panel, true);
  texture.needsUpdate = true;
}

function panelGeometrySize(mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>) {
  const parameters = mesh.geometry.parameters as { width?: number; height?: number };
  return {
    width: parameters.width ?? 1,
    height: parameters.height ?? 1,
  };
}

function sourceWorldRay(source: THREE.Object3D, origin: THREE.Vector3, direction: THREE.Vector3) {
  source.updateMatrixWorld(true);
  origin.setFromMatrixPosition(source.matrixWorld);
  direction.set(0, 0, -1).transformDirection(source.matrixWorld);
  if (direction.lengthSq() < 0.0001) {
    direction.set(0, 0, -1);
  } else {
    direction.normalize();
  }
}

function panelHitFromLocalPoint(
  key: XrPanelKey,
  panel: PanelCard,
  localPoint: THREE.Vector3,
  distance: number,
): XrPanelHit {
  const { width, height } = panelGeometrySize(panel.mesh);
  const canvasX = THREE.MathUtils.clamp((localPoint.x / width + 0.5) * panel.canvas.width, 0, panel.canvas.width);
  const canvasY = THREE.MathUtils.clamp((0.5 - localPoint.y / height) * panel.canvas.height, 0, panel.canvas.height);
  return {
    key,
    localX: localPoint.x,
    localY: localPoint.y,
    canvasX,
    canvasY,
    distance,
    zone: xrPanelHitZoneAt(panel, canvasX, canvasY),
  };
}

function sourceRayHitXrPanelDetail(runtime: StageRuntime, source: THREE.Object3D): XrPanelHit | null {
  source.updateMatrixWorld(true);
  const tempMatrix = new THREE.Matrix4().identity().extractRotation(source.matrixWorld);
  const origin = new THREE.Vector3().setFromMatrixPosition(source.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
  const inverseMatrix = new THREE.Matrix4();
  const localOrigin = new THREE.Vector3();
  const localDirection = new THREE.Vector3();
  const localHit = new THREE.Vector3();
  const closestHit = new THREE.Vector3();
  let closestPanel: PanelCard | null = null;
  let closestKey: XrPanelKey | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const key of Object.keys(runtime.panels) as XrPanelKey[]) {
    const panel = runtime.panels[key];
    if (!panel.mesh.visible) {
      continue;
    }
    panel.mesh.updateMatrixWorld(true);
    inverseMatrix.copy(panel.mesh.matrixWorld).invert();
    localOrigin.copy(origin).applyMatrix4(inverseMatrix);
    localDirection.copy(direction).transformDirection(inverseMatrix);
    if (Math.abs(localDirection.z) < 0.0001) {
      continue;
    }
    const hitDistance = -localOrigin.z / localDirection.z;
    if (hitDistance < 0 || hitDistance > closestDistance) {
      continue;
    }
    localHit.copy(localOrigin).addScaledVector(localDirection, hitDistance);
    const { width, height } = panelGeometrySize(panel.mesh);
    if (Math.abs(localHit.x) <= width / 2 && Math.abs(localHit.y) <= height / 2) {
      closestKey = key;
      closestPanel = panel;
      closestDistance = hitDistance;
      closestHit.copy(localHit);
    }
  }
  return closestKey && closestPanel ? panelHitFromLocalPoint(closestKey, closestPanel, closestHit, closestDistance) : null;
}

function sourceRayHitXrPanel(runtime: StageRuntime, source: THREE.Object3D): XrPanelKey | null {
  return sourceRayHitXrPanelDetail(runtime, source)?.key ?? null;
}

function sourceRayHitsXrPanel(runtime: StageRuntime, source: THREE.Object3D) {
  return Boolean(sourceRayHitXrPanel(runtime, source));
}

function sourceTouchXrPanelDetail(runtime: StageRuntime, source: THREE.Object3D): XrPanelHit | null {
  source.updateMatrixWorld(true);
  const worldPoint = new THREE.Vector3();
  const localPoint = new THREE.Vector3();
  const inverseMatrix = new THREE.Matrix4();
  source.getWorldPosition(worldPoint);

  for (const key of Object.keys(runtime.panels) as XrPanelKey[]) {
    const panel = runtime.panels[key];
    if (!panel.mesh.visible) {
      continue;
    }
    panel.mesh.updateMatrixWorld(true);
    inverseMatrix.copy(panel.mesh.matrixWorld).invert();
    localPoint.copy(worldPoint).applyMatrix4(inverseMatrix);
    const { width, height } = panelGeometrySize(panel.mesh);
    if (
      Math.abs(localPoint.x) <= width / 2 + XR_UI_PANEL_TOUCH_RADIUS &&
      Math.abs(localPoint.y) <= height / 2 + XR_UI_PANEL_TOUCH_RADIUS &&
      Math.abs(localPoint.z) <= XR_UI_PANEL_TOUCH_RADIUS
    ) {
      return panelHitFromLocalPoint(key, panel, localPoint, Math.abs(localPoint.z));
    }
  }
  return null;
}

function sourceTouchXrPanel(runtime: StageRuntime, source: THREE.Object3D): XrPanelKey | null {
  return sourceTouchXrPanelDetail(runtime, source)?.key ?? null;
}

function sourceTouchesXrPanel(runtime: StageRuntime, source: THREE.Object3D) {
  return Boolean(sourceTouchXrPanel(runtime, source));
}

function handTouchXrPanel(runtime: StageRuntime, hand: XRHandSpaceLike): XrPanelKey | null {
  const indexTip =
    hand.joints?.["index-finger-tip"] ??
    hand.joints?.["index-finger-phalanx-distal"] ??
    hand.joints?.["index-finger-phalanx-intermediate"];
  return sourceTouchXrPanel(runtime, indexTip ?? hand);
}

function handHitXrPanelDetail(runtime: StageRuntime, hand: XRHandSpaceLike): XrPanelHit | null {
  const indexTip =
    hand.joints?.["index-finger-tip"] ??
    hand.joints?.["index-finger-phalanx-distal"] ??
    hand.joints?.["index-finger-phalanx-intermediate"];
  return sourceTouchXrPanelDetail(runtime, indexTip ?? hand);
}

function handTouchesXrPanel(runtime: StageRuntime, hand: XRHandSpaceLike) {
  return Boolean(handTouchXrPanel(runtime, hand));
}

function xrNativeControlActionAt(hit: XrPanelHit): XrNativeControlAction | null {
  const windowControl = xrPanelWindowControlRectForHit(hit);
  if (windowControl) {
    return windowControl;
  }
  if (hit.key !== "status") {
    return null;
  }
  const zone = XR_STATUS_CONTROL_ZONES.find(
    (candidate) =>
      hit.canvasX >= candidate.x &&
      hit.canvasX <= candidate.x + candidate.width &&
      hit.canvasY >= candidate.y &&
      hit.canvasY <= candidate.y + candidate.height,
  );
  return zone?.action ?? null;
}

function xrPanelWindowControlRectForHit(hit: XrPanelHit): XrNativeControlAction | null {
  return hit.zone === "window-control" ? "toggle-panel-minimized" : null;
}

function xrNativeControlDiagnosticLabel(action: XrNativeControlAction): string {
  switch (action) {
    case "place-yuki":
      return "Place Yuki";
    case "use-seat":
      return "Seat";
    case "stand-table":
      return "Table";
    case "toggle-mic":
      return "Mic";
    case "toggle-deck":
      return "Deck";
    case "toggle-panel-minimized":
      return "Minimize";
    case "follow-anchor":
      return "Anchor";
    case "next-worker":
      return "Next worker";
    case "previous-worker":
      return "Previous worker";
  }
}

function xrPanelClickAction(hit: XrPanelHit | null, deckMode: XrDeckMode): XrNativeControlAction | null {
  const action = hit ? xrNativeControlActionAt(hit) : null;
  if (!action) {
    return null;
  }
  return action === "toggle-deck" ||
    action === "toggle-panel-minimized" ||
    action === "toggle-mic" ||
    deckMode === "expanded"
    ? action
    : null;
}

function drawXrInputDiagnosticPanel(
  diagnostics: XrInputDiagnosticPanel,
  message: string,
  severity: XrInputDiagnosticSeverity,
) {
  const { canvas, context, texture } = diagnostics;
  const width = canvas.width;
  const height = canvas.height;
  const accent =
    severity === "warning" ? "#ffd166" : severity === "active" ? "#57f0b7" : "#7dd3fc";
  const background =
    severity === "warning"
      ? "rgba(39, 26, 4, 0.9)"
      : severity === "active"
        ? "rgba(4, 38, 30, 0.9)"
        : "rgba(5, 20, 34, 0.9)";

  context.clearRect(0, 0, width, height);
  context.fillStyle = background;
  roundRect(context, 22, 22, width - 44, height - 44, 32);
  context.fill();
  context.strokeStyle = accent;
  context.lineWidth = 5;
  roundRect(context, 22, 22, width - 44, height - 44, 32);
  context.stroke();

  context.fillStyle = accent;
  roundRect(context, 52, 58, 148, 58, 29);
  context.fill();
  context.fillStyle = severity === "warning" ? "#241704" : "#031720";
  context.font = "900 25px Inter, system-ui, sans-serif";
  context.fillText("XR INPUT", 76, 95);

  context.fillStyle = "#f2fbff";
  context.font = "800 28px Inter, system-ui, sans-serif";
  drawWrappedText(context, message, 226, 78, width - 278, 2, 34);
  texture.needsUpdate = true;
}

function setXrInputDiagnostic(
  diagnostics: XrInputDiagnosticPanel,
  message: string | null,
  severity: XrInputDiagnosticSeverity = "info",
) {
  if (!diagnostics.mesh.parent) {
    diagnostics.mesh.visible = false;
    diagnostics.lastMessage = message ?? "";
    diagnostics.lastSeverity = message ? severity : null;
    return;
  }
  if (!message) {
    diagnostics.mesh.visible = false;
    diagnostics.lastMessage = "";
    diagnostics.lastSeverity = null;
    return;
  }
  diagnostics.mesh.visible = true;
  const now = performance.now();
  if (
    diagnostics.lastMessage !== message ||
    diagnostics.lastSeverity !== severity ||
    now - diagnostics.lastDrawAt > 500
  ) {
    diagnostics.lastMessage = message;
    diagnostics.lastSeverity = severity;
    diagnostics.lastDrawAt = now;
    drawXrInputDiagnosticPanel(diagnostics, message, severity);
  }
}

function updateXrPanelPointerFeedback(runtime: StageRuntime, activeXrSession: boolean) {
  const placement = runtime.xrUi;
  let hoverHit: XrPanelHit | null = null;
  for (const { pointer } of xrControllerEntries(runtime)) {
    if (activeXrSession && pointer.lastHit) {
      hoverHit = pointer.lastHit;
    }
  }
  const hoverPanel = placement.dragPanel ?? placement.pendingPanel ?? hoverHit?.key ?? null;
  const hoverAction =
    placement.dragClickAction ??
    placement.pendingClickAction ??
    (hoverHit ? xrNativeControlActionAt(hoverHit) : null);
  const hoverZone = placement.dragPanel ? "move-bar" : hoverHit?.zone ?? null;

  placement.hoverPanel = activeXrSession ? hoverPanel : null;
  placement.hoverAction = activeXrSession ? hoverAction : null;
  placement.hoverZone = activeXrSession ? hoverZone : null;

  for (const key of Object.keys(runtime.panels) as XrPanelKey[]) {
    const panel = runtime.panels[key];
    const dragging = activeXrSession && placement.dragPanel === key;
    const pressing = activeXrSession && placement.pendingPanel === key;
    const hovering = activeXrSession && hoverPanel === key;
    panel.mesh.material.color.setHex(dragging ? 0xd9ffef : pressing ? 0xfff2c4 : hovering ? 0xe3f7ff : 0xffffff);
    panel.mesh.material.opacity = 1;
  }
}

function updateXrInputDiagnostics(runtime: StageRuntime, activeXrSession: boolean) {
  if (!activeXrSession) {
    setXrInputDiagnostic(runtime.xrDiagnostics, null);
    return;
  }

  const placement = runtime.xrUi;
  const now = performance.now();
  const sessionInputSources = runtime.world.session?.inputSources
    ? Array.from(runtime.world.session.inputSources)
    : [];
  const sessionInputCount = sessionInputSources.length;
  const sessionControllerCount = sessionInputSources.filter(xrInputSourceIsQuestController).length;
  const leftBound = xrHasBoundHand(runtime, "left");
  const rightBound = xrHasBoundHand(runtime, "right");
  const leftTracked = xrHasTrackedControllerHand(runtime, "left");
  const rightTracked = xrHasTrackedControllerHand(runtime, "right");
  const inputSummary =
    `${sessionInputCount} source${sessionInputCount === 1 ? "" : "s"}, ` +
    `${sessionControllerCount} controller${sessionControllerCount === 1 ? "" : "s"}; ` +
    `L ${leftTracked ? "tracked" : leftBound ? "bound/untracked" : "missing"} / ` +
    `R ${rightTracked ? "tracked" : rightBound ? "bound/untracked" : "missing"}`;

  if (sessionInputCount === 0 && !leftBound && !rightBound) {
    setXrInputDiagnostic(
      runtime.xrDiagnostics,
      "No Quest controller input sources detected yet. Panel taps activate once tracked input binds.",
      "warning",
    );
    return;
  }
  if (sessionInputCount > 0 && !leftTracked && !rightTracked) {
    setXrInputDiagnostic(
      runtime.xrDiagnostics,
      `No tracked Quest controller is bound yet. ${inputSummary}. Panel taps need tracked input.`,
      "warning",
    );
    return;
  }
  if (placement.dragSource && placement.dragPanel) {
    setXrInputDiagnostic(
      runtime.xrDiagnostics,
      `Grab moving ${xrPanelFocusLabel(placement.dragPanel)}. Release grab to place it.`,
      "active",
    );
    return;
  }
  if (placement.pendingSource && placement.pendingPanel) {
    setXrInputDiagnostic(
      runtime.xrDiagnostics,
      `Trigger on ${xrPanelFocusLabel(placement.pendingPanel)}. Release to click. Rail, edge, or corner grab moves panels.`,
      "active",
    );
    return;
  }
  if (now - placement.lastPointerMissAt < XR_UI_MISSED_HIT_DIAGNOSTIC_MS) {
    setXrInputDiagnostic(runtime.xrDiagnostics, `${placement.lastPointerEventLabel}. Aim at a panel surface.`, "warning");
    return;
  }
  if (placement.hoverPanel) {
    const action = placement.hoverAction ? ` ${xrNativeControlDiagnosticLabel(placement.hoverAction)}.` : "";
    const moveHint =
      placement.hoverZone === "move-bar" || placement.hoverZone === "edge" || placement.hoverZone === "corner"
        ? " Grab moves this panel."
        : " Trigger clicks; grab rail, edge, or corner to move.";
    setXrInputDiagnostic(
      runtime.xrDiagnostics,
      `Hovering ${xrPanelFocusLabel(placement.hoverPanel)}.${action}${moveHint}`,
      "info",
    );
    return;
  }
  if (stageDebugEnabled()) {
    setXrInputDiagnostic(runtime.xrDiagnostics, inputSummary, "info");
    return;
  }
  setXrInputDiagnostic(runtime.xrDiagnostics, null);
}

function setXrPointerColor(pointer: XrPointerVisual, color: number, opacity: number) {
  pointer.line.material.color.setHex(color);
  pointer.line.material.opacity = opacity;
  pointer.cursor.material.color.setHex(color);
  pointer.cursor.material.opacity = Math.min(1, opacity + 0.22);
}

function updateXrPointerVisual(
  runtime: StageRuntime,
  source: THREE.Object3D,
  pointer: XrPointerVisual,
  activeXrSession: boolean,
) {
  const inputSource = xrTrackedControllerInputSource(source, runtime);
  const tracked = activeXrSession && Boolean(inputSource);
  pointer.line.visible = false;
  pointer.cursor.visible = false;
  if (!tracked) {
    pointer.cursor.visible = false;
    pointer.lastHit = null;
    return;
  }

  const hit = sourceRayHitXrPanelDetail(runtime, source);
  pointer.lastHit = hit;
  if (!XR_POINTER_VISUALS_ENABLED) {
    return;
  }
  pointer.line.visible = true;
  const dragging = runtime.xrUi.dragSource === source;
  const pressing = runtime.xrUi.pendingSource === source;
  const movableHit = xrPanelHitCanMovePanel(hit);
  const color = dragging ? 0x57f0b7 : pressing ? 0xffd166 : movableHit ? 0x57f0b7 : hit ? 0x7dd3fc : 0x9aa8bb;
  setXrPointerColor(pointer, color, dragging || pressing || hit ? 0.92 : 0.42);

  sourceWorldRay(source, pointer.origin, pointer.direction);
  let rayLength = XR_POINTER_DEFAULT_LENGTH;
  if (hit) {
    const panel = runtime.panels[hit.key];
    pointer.hitPoint.set(hit.localX, hit.localY, 0).applyMatrix4(panel.mesh.matrixWorld);
    rayLength = THREE.MathUtils.clamp(pointer.origin.distanceTo(pointer.hitPoint), 0.16, XR_POINTER_DEFAULT_LENGTH);
    pointer.cursor.visible = true;
    pointer.cursor.position.copy(pointer.hitPoint).addScaledVector(pointer.direction, -0.006);
    runtime.camera.updateMatrixWorld(true);
    pointer.cursor.lookAt(runtime.camera.position);
    pointer.cursor.scale.setScalar(dragging ? 1.42 : pressing ? 1.28 : movableHit ? 1.22 : xrNativeControlActionAt(hit) ? 1.18 : 1);
  } else {
    pointer.cursor.visible = false;
  }
  pointer.line.scale.set(1, 1, rayLength);
}

function currentXrPointerHit(
  runtime: StageRuntime,
  source: THREE.Object3D,
  pointer?: XrPointerVisual,
) {
  return sourceRayHitXrPanelDetail(runtime, source) ?? sourceTouchXrPanelDetail(runtime, source) ?? pointer?.lastHit ?? null;
}

function xrPanelHitWorldPoint(runtime: StageRuntime, hit: XrPanelHit, target: THREE.Vector3) {
  const panel = runtime.panels[hit.key];
  panel.mesh.updateMatrixWorld(true);
  return target.set(hit.localX, hit.localY, 0).applyMatrix4(panel.mesh.matrixWorld);
}

function clearXrUiPendingPress(placement: XrUiPlacementState) {
  placement.pendingSource = null;
  placement.pendingPanel = null;
  placement.pendingPointerKind = null;
  placement.pendingClickAction = null;
  placement.pendingStartedAt = 0;
  placement.pendingRayDistance = XR_UI_DISTANCE;
}

function clearXrUiDrag(placement: XrUiPlacementState) {
  placement.dragSource = null;
  placement.dragPanel = null;
  placement.dragPointerKind = null;
  placement.dragClickAction = null;
  placement.dragClickSuppressed = false;
  placement.dragDistanceOffset = 0;
  placement.dragHeightOffset = 0;
  placement.dragMoved = false;
}

function clearXrPanelManualPlacement(placement: XrUiPlacementState) {
  XR_PANEL_KEYS.forEach((key) => {
    placement.panelManualPlacement[key] = false;
  });
}

function rememberXrPanelManualTransform(runtime: StageRuntime, panel: XrPanelKey) {
  const placement = runtime.xrUi;
  const panelMesh = runtime.panels[panel].mesh;
  placement.panelManualPlacement[panel] = true;
  placement.panelManualPositions[panel].copy(panelMesh.position);
  placement.panelManualQuaternions[panel].copy(panelMesh.quaternion);
}

function setXrPanelWorldPosition(runtime: StageRuntime, panel: XrPanelKey, worldPosition: THREE.Vector3) {
  const placement = runtime.xrUi;
  const panelMesh = runtime.panels[panel].mesh;
  const parent = panelMesh.parent;
  if (parent) {
    parent.updateMatrixWorld(true);
    placement.panelLocalPosition.copy(worldPosition);
    parent.worldToLocal(placement.panelLocalPosition);
    panelMesh.position.copy(placement.panelLocalPosition);
  } else {
    panelMesh.position.copy(worldPosition);
  }
}

function startXrUiDeckPress(
  runtime: StageRuntime,
  source: THREE.Object3D,
  panel: XrPanelKey,
  options: {
    pointerKind?: XrPanelPointerKind;
    clickAction?: XrNativeControlAction | null;
    hit?: XrPanelHit | null;
  } = {},
) {
  const placement = runtime.xrUi;
  clearXrUiPendingPress(placement);
  sourceWorldRay(source, placement.sourcePosition, placement.sourceDirection);
  if (options.hit) {
    xrPanelHitWorldPoint(runtime, options.hit, placement.pendingStartRayPoint);
  } else {
    placement.pendingStartRayPoint
      .copy(placement.sourcePosition)
      .addScaledVector(placement.sourceDirection, XR_UI_DISTANCE);
  }
  placement.pendingRayDistance = THREE.MathUtils.clamp(
    placement.pendingStartRayPoint.distanceTo(placement.sourcePosition),
    0.16,
    XR_UI_MAX_DISTANCE,
  );
  placement.pendingCurrentRayPoint.copy(placement.pendingStartRayPoint);
  placement.pendingSource = source;
  placement.pendingPanel = panel;
  placement.pendingPointerKind = options.pointerKind ?? "select";
  placement.pendingClickAction = options.clickAction ?? null;
  placement.pendingStartedAt = performance.now();
  placement.lastPointerEventAt = placement.pendingStartedAt;
  placement.lastPointerEventLabel = `Pressed ${panel}`;
}

function startXrUiDeckDrag(
  runtime: StageRuntime,
  source: THREE.Object3D,
  panel: XrPanelKey,
  options: {
    pointerKind?: XrPanelPointerKind;
    clickAction?: XrNativeControlAction | null;
    hit?: XrPanelHit | null;
    hitPoint?: THREE.Vector3 | null;
    startedAt?: number;
    suppressClick?: boolean;
  } = {},
): boolean {
  const pointerKind = options.pointerKind ?? "squeeze";
  if (pointerKind !== "squeeze") {
    return false;
  }
  const placement = runtime.xrUi;
  if (options.hit && !xrPanelHitCanMovePanel(options.hit)) {
    placement.lastPointerEventAt = performance.now();
    placement.lastPointerEventLabel =
      options.hit.zone === "window-control"
        ? "Window control is trigger-only"
        : `Grab the ${xrPanelFocusLabel(options.hit.key)} rail, edge, or corner to move it`;
    return false;
  }
  clearXrUiPendingPress(placement);
  sourceWorldRay(source, placement.sourcePosition, placement.sourceDirection);
  const panelMesh = runtime.panels[panel].mesh;
  panelMesh.updateMatrixWorld(true);
  placement.targetPosition.setFromMatrixPosition(panelMesh.matrixWorld);
  placement.dragStartPosition.copy(placement.targetPosition);
  const hitPanel = options.hit ? runtime.panels[options.hit.key] : null;
  const hitDistance = (() => {
    if (options.hitPoint) {
      placement.sourceHitPosition.copy(options.hitPoint);
      return placement.sourceHitPosition.clone().sub(placement.sourcePosition).dot(placement.sourceDirection);
    }
    if (!options.hit || !hitPanel) {
      return Number.NaN;
    }
    xrPanelHitWorldPoint(runtime, options.hit, placement.sourceHitPosition);
    return placement.sourceHitPosition.clone().sub(placement.sourcePosition).dot(placement.sourceDirection);
  })();
  placement.dragDistance = THREE.MathUtils.clamp(
    Number.isFinite(hitDistance)
      ? hitDistance
      : placement.targetPosition.clone().sub(placement.sourcePosition).dot(placement.sourceDirection),
    XR_UI_MIN_DISTANCE,
    XR_UI_MAX_DISTANCE,
  );
  placement.sourceHitPosition
    .copy(placement.sourcePosition)
    .addScaledVector(placement.sourceDirection, placement.dragDistance);
  placement.dragOffset.copy(placement.targetPosition).sub(placement.sourceHitPosition);
  placement.dragDistanceOffset = 0;
  placement.dragHeightOffset = 0;
  placement.dragSource = source;
  placement.dragPanel = panel;
  placement.dragPointerKind = pointerKind;
  placement.dragClickAction = options.clickAction ?? null;
  placement.dragClickSuppressed = options.suppressClick ?? false;
  placement.dragStartedAt = options.startedAt ?? performance.now();
  placement.dragMoved = false;
  placement.lastPointerEventAt = performance.now();
  placement.lastPointerEventLabel = `Dragging ${panel}`;
  placement.manualPlacement = true;
  rememberXrPanelManualTransform(runtime, panel);
  placement.recenterRequested = false;
  return true;
}

function promoteXrUiPendingPressToDrag(runtime: StageRuntime, reason: "hold" | "move") {
  const placement = runtime.xrUi;
  if (!placement.pendingSource || !placement.pendingPanel) {
    return false;
  }
  const source = placement.pendingSource;
  const panel = placement.pendingPanel;
  const pointerKind = placement.pendingPointerKind ?? "select";
  if (pointerKind !== "squeeze") {
    return false;
  }
  const clickAction = placement.pendingClickAction;
  const startedAt = placement.pendingStartedAt;
  const hitPoint = placement.pendingCurrentRayPoint.clone();
  if (!startXrUiDeckDrag(runtime, source, panel, {
    pointerKind,
    clickAction,
    hitPoint,
    startedAt,
    suppressClick: true,
  })) {
    return false;
  }
  placement.dragMoved = reason === "move";
  placement.lastPointerEventLabel =
    reason === "hold" ? `Hold moving ${panel}` : `Ray moving ${panel}`;
  return true;
}

function updateXrUiPendingPress(runtime: StageRuntime) {
  const placement = runtime.xrUi;
  const source = placement.pendingSource;
  if (!source) {
    return false;
  }
  if (placement.pendingPointerKind !== "squeeze") {
    return false;
  }

  sourceWorldRay(source, placement.sourcePosition, placement.sourceDirection);
  placement.pendingCurrentRayPoint
    .copy(placement.sourcePosition)
    .addScaledVector(placement.sourceDirection, placement.pendingRayDistance);
  const heldMs = performance.now() - placement.pendingStartedAt;
  const movedDistance = placement.pendingCurrentRayPoint.distanceTo(placement.pendingStartRayPoint);
  if (heldMs >= XR_UI_PINCH_HOLD_DRAG_MS) {
    return promoteXrUiPendingPressToDrag(runtime, "hold");
  }
  if (movedDistance >= XR_UI_PINCH_DRAG_RAY_THRESHOLD) {
    return promoteXrUiPendingPressToDrag(runtime, "move");
  }
  return false;
}

function endXrUiDeckPress(
  runtime: StageRuntime,
  source?: THREE.Object3D,
  pointerKind?: XrPanelPointerKind,
): XrPanelDragEnd | null {
  const placement = runtime.xrUi;
  if (
    !placement.pendingSource ||
    (source && placement.pendingSource !== source) ||
    (pointerKind && placement.pendingPointerKind !== pointerKind)
  ) {
    return null;
  }

  sourceWorldRay(placement.pendingSource, placement.sourcePosition, placement.sourceDirection);
  placement.pendingCurrentRayPoint
    .copy(placement.sourcePosition)
    .addScaledVector(placement.sourceDirection, placement.pendingRayDistance);
  const panel = placement.pendingPanel;
  const clickAction = placement.pendingClickAction;
  const heldMs = performance.now() - placement.pendingStartedAt;
  const movedDistance = placement.pendingCurrentRayPoint.distanceTo(placement.pendingStartRayPoint);
  const shouldClick =
    placement.pendingPointerKind === "select" ||
    (heldMs < XR_UI_PINCH_HOLD_DRAG_MS && movedDistance < XR_UI_PINCH_DRAG_RAY_THRESHOLD);
  placement.lastPointerEventAt = performance.now();
  placement.lastPointerEventLabel = shouldClick && panel ? `Tapped ${panel}` : "Released trigger";
  clearXrUiPendingPress(placement);
  return { panel, clickAction, shouldClick };
}

function endXrUiDeckDrag(
  runtime: StageRuntime,
  source?: THREE.Object3D,
  pointerKind?: XrPanelPointerKind,
): XrPanelDragEnd | null {
  const placement = runtime.xrUi;
  if (
    !placement.dragSource ||
    (source && placement.dragSource !== source) ||
    (pointerKind && placement.dragPointerKind !== pointerKind)
  ) {
    return null;
  }
  const panel = placement.dragPanel;
  const clickAction = placement.dragClickAction;
  if (panel) {
    rememberXrPanelManualTransform(runtime, panel);
  }
  placement.manualPlacement = true;
  clearXrUiDrag(placement);
  return { panel, clickAction, shouldClick: false };
}

type XrLogicalHandedness = "left" | "right";

type XrControllerEntry = {
  controller: THREE.Group;
  pointer: XrPointerVisual;
  slotLabel: "controller[0]" | "controller[1]";
};

function controllerInputSource(controller: THREE.Object3D): XRInputSource | null {
  return ((controller as XRControllerWithInputSource).userData.inputSource as XRInputSource | undefined) ?? null;
}

function bindInputSourceToObject(target: THREE.Object3D, inputSource: XRInputSource) {
  const userData = (target as XRControllerWithInputSource).userData;
  userData.inputSource = inputSource;
  userData.inputSourceConnectedAt = performance.now();
}

function unbindInputSourceFromObject(target: THREE.Object3D, inputSource?: XRInputSource) {
  const userData = (target as XRControllerWithInputSource).userData;
  const currentInputSource = userData.inputSource;
  if (!inputSource || !currentInputSource || currentInputSource === inputSource) {
    delete userData.inputSource;
    userData.inputSourceDisconnectedAt = performance.now();
  }
}

function rememberInputSourceFromEvent(target: THREE.Object3D, event: unknown) {
  const inputSource = (event as { data?: XRInputSource }).data;
  if (inputSource) {
    bindInputSourceToObject(target, inputSource);
  }
  return inputSource ?? null;
}

function xrLogicalHandedness(handedness: XRHandedness | "" | undefined): XrLogicalHandedness | null {
  return handedness === "left" || handedness === "right" ? handedness : null;
}

function xrInputSourceHandedness(inputSource: XRInputSource | null | undefined): XrLogicalHandedness | null {
  return xrLogicalHandedness(inputSource?.handedness);
}

function xrInputSourceIsQuestController(inputSource: XRInputSource | null | undefined) {
  return Boolean(inputSource?.gamepad && inputSource.targetRayMode === "tracked-pointer");
}

function xrSessionIncludesInputSource(runtime: StageRuntime, inputSource: XRInputSource) {
  const sessionSources = runtime.world.session?.inputSources;
  return !sessionSources || Array.from(sessionSources).includes(inputSource);
}

function xrTrackedControllerInputSource(controller: THREE.Object3D, runtime?: StageRuntime): XRInputSource | null {
  const inputSource = controllerInputSource(controller);
  if (!inputSource || !controller.visible || !xrInputSourceIsQuestController(inputSource)) {
    return null;
  }
  if (runtime && !xrSessionIncludesInputSource(runtime, inputSource)) {
    return null;
  }
  return inputSource;
}

function xrControllerEntries(runtime: StageRuntime): XrControllerEntry[] {
  return [
    { controller: runtime.leftController, pointer: runtime.leftPointer, slotLabel: "controller[0]" },
    { controller: runtime.rightController, pointer: runtime.rightPointer, slotLabel: "controller[1]" },
  ];
}

function xrPointerForController(runtime: StageRuntime, controller: THREE.Object3D): XrPointerVisual | undefined {
  return xrControllerEntries(runtime).find((entry) => entry.controller === controller)?.pointer;
}

function xrControllerEntryForHand(runtime: StageRuntime, handedness: XrLogicalHandedness): XrControllerEntry | null {
  return (
    xrControllerEntries(runtime).find(
      (entry) => xrInputSourceHandedness(controllerInputSource(entry.controller)) === handedness,
    ) ?? null
  );
}

function xrHasBoundHand(runtime: StageRuntime, handedness: XrLogicalHandedness) {
  return Boolean(xrControllerEntryForHand(runtime, handedness));
}

function xrTrackedControllerForHand(runtime: StageRuntime, handedness: XrLogicalHandedness): THREE.Group | null {
  return (
    xrControllerEntries(runtime).find(
      ({ controller }) => xrInputSourceHandedness(xrTrackedControllerInputSource(controller, runtime)) === handedness,
    )?.controller ?? null
  );
}

function xrHasTrackedControllerHand(runtime: StageRuntime, handedness: XrLogicalHandedness) {
  return Boolean(xrTrackedControllerForHand(runtime, handedness));
}

function xrGripForHand(runtime: StageRuntime, handedness: XrLogicalHandedness): THREE.Group | null {
  return (
    [runtime.leftGrip, runtime.rightGrip].find((grip) => {
      const inputSource = controllerInputSource(grip);
      return (
        grip.visible &&
        Boolean(inputSource && xrSessionIncludesInputSource(runtime, inputSource)) &&
        xrInputSourceHandedness(inputSource) === handedness
      );
    }) ?? null
  );
}

function xrHandSpaceForHand(runtime: StageRuntime, handedness: XrLogicalHandedness): XRHandSpaceLike | null {
  return (
    [runtime.leftHand, runtime.rightHand].find((hand) => {
      const inputSource = controllerInputSource(hand);
      return (
        hand.visible &&
        Boolean(inputSource && xrSessionIncludesInputSource(runtime, inputSource)) &&
        xrInputSourceHandedness(inputSource) === handedness
      );
    }) ?? null
  );
}

function xrInputSourceForHand(runtime: StageRuntime, handedness: XrLogicalHandedness): XRInputSource | null {
  const sessionInputSources = runtime.world.session?.inputSources;
  if (sessionInputSources) {
    for (const inputSource of Array.from(sessionInputSources)) {
      if (xrInputSourceHandedness(inputSource) === handedness) {
        return inputSource;
      }
    }
  }
  const controller = xrControllerEntryForHand(runtime, handedness)?.controller;
  return controller ? controllerInputSource(controller) : null;
}

function bindControllerInputSource(controller: THREE.Object3D, removers: Array<() => void>) {
  const eventTarget = controller as THREE.Object3D & {
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
  };
  const connected = (event: unknown) => {
    const inputSource = (event as { data?: XRInputSource }).data;
    if (inputSource) {
      bindInputSourceToObject(controller, inputSource);
    }
  };
  const disconnected = (event: unknown) => {
    unbindInputSourceFromObject(controller, (event as { data?: XRInputSource }).data);
  };
  eventTarget.addEventListener("connected", connected);
  eventTarget.addEventListener("disconnected", disconnected);
  removers.push(() => {
    eventTarget.removeEventListener("connected", connected);
    eventTarget.removeEventListener("disconnected", disconnected);
  });
}

function bestGamepadAxisPair(gamepad: Gamepad | null | undefined): { x: number; y: number } | null {
  const axes = gamepad?.axes;
  if (!axes || axes.length < 2) {
    return null;
  }
  let best: { x: number; y: number } | null = null;
  let bestMagnitude = 0;
  for (let index = 0; index < axes.length - 1; index += 1) {
    const x = axes[index] ?? 0;
    const y = axes[index + 1] ?? 0;
    const magnitude = Math.abs(x) + Math.abs(y);
    if (magnitude > bestMagnitude) {
      best = { x, y };
      bestMagnitude = magnitude;
    }
  }
  return best;
}

function dominantJoystickDirection(axes: { x: number; y: number } | null): 1 | -1 | 0 {
  if (!axes) {
    return 0;
  }
  const strongestAxis = Math.abs(axes.x) >= Math.abs(axes.y) ? axes.x : axes.y;
  return Math.abs(strongestAxis) >= XR_JOYSTICK_AXIS_THRESHOLD ? (strongestAxis > 0 ? 1 : -1) : 0;
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

  const scale = AVATAR_TARGET_HEIGHT / Math.max(size.y, 0.001);
  scene.scale.setScalar(scale);
  scene.userData.basePresenceScale = scale;

  const scaledBounds = new THREE.Box3().setFromObject(scene);
  const scaledCenter = new THREE.Vector3();
  scaledBounds.getCenter(scaledCenter);
  scene.position.set(-scaledCenter.x, -scaledBounds.min.y + AVATAR_BASE_FLOOR_CLEARANCE, -scaledCenter.z);
}

type ColorTunableMaterial = THREE.Material & {
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  shadeColorFactor?: THREE.Color;
  matcapFactor?: THREE.Color;
  parametricRimColorFactor?: THREE.Color;
  outlineColorFactor?: THREE.Color;
};

function isYukiHairMaterial(mesh: THREE.Mesh, material: THREE.Material) {
  const materialName = material.name.trim();
  const meshName = mesh.name.trim();
  const label = `${meshName} ${materialName}`;
  if (/(face|eye|iris|skin|mouth|brow|lash|eyeline)/i.test(label)) {
    return false;
  }
  return /(?:^|[_\s-])hair(?:$|[_\s-])/i.test(label) || /_HAIR\b/i.test(materialName);
}

function forceYukiHairMaterialBlack(material: THREE.Material) {
  const tunable = material as ColorTunableMaterial;
  tunable.color?.copy(YUKI_HAIR_COLOR);
  tunable.emissive?.copy(YUKI_HAIR_SHADE_COLOR);
  tunable.shadeColorFactor?.copy(YUKI_HAIR_SHADE_COLOR);
  tunable.matcapFactor?.copy(YUKI_HAIR_SHADE_COLOR);
  tunable.parametricRimColorFactor?.copy(YUKI_HAIR_SHADE_COLOR);
  tunable.outlineColorFactor?.copy(YUKI_HAIR_SHADE_COLOR);
  if (typeof tunable.emissiveIntensity === "number") {
    tunable.emissiveIntensity = 0;
  }
  if (typeof tunable.roughness === "number") {
    tunable.roughness = Math.max(tunable.roughness, 0.86);
  }
  if (typeof tunable.metalness === "number") {
    tunable.metalness = 0;
  }
  material.needsUpdate = true;
}

function forceYukiHairMaterialsBlack(scene: THREE.Object3D) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh & {
      isMesh?: boolean;
      material?: THREE.Material | THREE.Material[];
    };
    if (!mesh.isMesh || !mesh.material) {
      return;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      if (isYukiHairMaterial(mesh, material)) {
        forceYukiHairMaterialBlack(material);
      }
    });
  });
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
      leftUpperLeg: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftUpperLeg)),
      leftLowerLeg: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftLowerLeg)),
      leftFoot: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftFoot)),
      leftToes: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftToes)),
      rightShoulder: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightShoulder)),
      rightUpperArm: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightUpperArm)),
      rightLowerArm: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightLowerArm)),
      rightHand: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightHand)),
      rightUpperLeg: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightUpperLeg)),
      rightLowerLeg: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightLowerLeg)),
      rightFoot: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightFoot)),
      rightToes: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightToes)),
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
    leftUpperLeg: lookup.get("J_Bip_L_UpperLeg"),
    leftLowerLeg: lookup.get("J_Bip_L_LowerLeg"),
    leftFoot: lookup.get("J_Bip_L_Foot"),
    leftToes: lookup.get("J_Bip_L_ToeBase"),
    rightShoulder: lookup.get("J_Bip_R_Shoulder"),
    rightUpperArm: lookup.get("J_Bip_R_UpperArm"),
    rightLowerArm: lookup.get("J_Bip_R_LowerArm"),
    rightHand: lookup.get("J_Bip_R_Hand"),
    rightUpperLeg: lookup.get("J_Bip_R_UpperLeg"),
    rightLowerLeg: lookup.get("J_Bip_R_LowerLeg"),
    rightFoot: lookup.get("J_Bip_R_Foot"),
    rightToes: lookup.get("J_Bip_R_ToeBase"),
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
    case "sitting":
      return "idle";
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

function setAvatarClipState(
  controller: AvatarAnimationController,
  state: AvatarClipState,
  clipTimeScale = 1,
  crossFadeSeconds = 0.28,
) {
  const clampedTimeScale = THREE.MathUtils.clamp(clipTimeScale, 0.65, 1.35);
  const clampedFadeSeconds = THREE.MathUtils.clamp(crossFadeSeconds, 0.08, 0.55);

  if (controller.activeState === state) {
    const activeAction = controller.actions[state];
    if (activeAction) {
      activeAction.setEffectiveTimeScale(clampedTimeScale);
    }
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
  nextAction.setEffectiveTimeScale(clampedTimeScale);
  nextAction.setEffectiveWeight(1);

  if (previousAction && previousAction !== nextAction) {
    previousAction.crossFadeTo(nextAction, clampedFadeSeconds, true);
  } else {
    nextAction.fadeIn(Math.min(clampedFadeSeconds, 0.22));
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

function applyAvatarSeatedPose(rig: AvatarRig, elapsed: number, speechSpeaking: boolean) {
  const breath = Math.sin(elapsed * 1.45) * 0.012;
  const talk = speechSpeaking ? Math.sin(elapsed * 4.2) * 0.08 : 0;

  poseBone(rig, rig.hips, -0.1, 0, 0);
  poseBone(rig, rig.spine, -0.08 + breath, 0, 0);
  poseBone(rig, rig.chest, -0.04 + breath * 1.4, talk * 0.12, 0);
  poseBone(rig, rig.upperChest, -0.02 + breath * 1.8, talk * 0.16, 0);
  poseBone(rig, rig.neck, -0.02, talk * 0.1, 0);
  poseBone(rig, rig.head, 0.02 + talk * 0.25, talk * 0.14, 0);

  poseBone(rig, rig.leftUpperLeg, -1.12, 0.12, -0.08);
  poseBone(rig, rig.leftLowerLeg, 1.26, 0, 0.08);
  poseBone(rig, rig.leftFoot, -0.18, 0.02, 0.02);
  poseBone(rig, rig.leftToes, -0.08, 0, 0);
  poseBone(rig, rig.rightUpperLeg, -1.12, -0.12, 0.08);
  poseBone(rig, rig.rightLowerLeg, 1.26, 0, -0.08);
  poseBone(rig, rig.rightFoot, -0.18, -0.02, -0.02);
  poseBone(rig, rig.rightToes, -0.08, 0, 0);

  poseBone(rig, rig.leftShoulder, 0.06, 0.05, -0.08);
  poseBone(rig, rig.leftUpperArm, -0.34 + talk * 0.22, 0.12, -0.54);
  poseBone(rig, rig.leftLowerArm, -0.72 + talk * 0.18, 0.04, -0.18);
  poseBone(rig, rig.leftHand, 0.08, 0.04, 0);
  poseBone(rig, rig.rightShoulder, 0.06, -0.05, 0.08);
  poseBone(rig, rig.rightUpperArm, -0.34 - talk * 0.22, -0.12, 0.54);
  poseBone(rig, rig.rightLowerArm, -0.72 - talk * 0.18, -0.04, 0.18);
  poseBone(rig, rig.rightHand, 0.08, -0.04, 0);
}

function createAvatarGroundingState(): AvatarGroundingState {
  return {
    bounds: new THREE.Box3(),
    center: new THREE.Vector3(),
    size: new THREE.Vector3(),
    samplePosition: new THREE.Vector3(),
    leftFootTarget: new THREE.Vector3(),
    rightFootTarget: new THREE.Vector3(),
    leftFootWorld: new THREE.Vector3(),
    rightFootWorld: new THREE.Vector3(),
    hipWorld: new THREE.Vector3(),
    effectorWorld: new THREE.Vector3(),
    targetWorld: new THREE.Vector3(),
    jointWorld: new THREE.Vector3(),
    effectorDirection: new THREE.Vector3(),
    targetDirection: new THREE.Vector3(),
    parentQuaternion: new THREE.Quaternion(),
    parentQuaternionInverse: new THREE.Quaternion(),
    worldDelta: new THREE.Quaternion(),
    localDelta: new THREE.Quaternion(),
    identityQuaternion: new THREE.Quaternion(),
    smoothedLift: 0,
    lastMeasuredMinY: Number.POSITIVE_INFINITY,
    footTargetsInitialized: false,
    lastPlacementAt: Number.NEGATIVE_INFINITY,
  };
}

function sampleLowestRigBoneY(rig: AvatarRig | null, grounding: AvatarGroundingState) {
  if (!rig) {
    return null;
  }

  const feet = [rig.leftFoot, rig.leftToes, rig.rightFoot, rig.rightToes];
  let minY = Number.POSITIVE_INFINITY;
  feet.forEach((bone) => {
    if (!bone) {
      return;
    }
    bone.getWorldPosition(grounding.samplePosition);
    minY = Math.min(minY, grounding.samplePosition.y);
  });

  return Number.isFinite(minY) ? minY : null;
}

function footHorizontalDistance(a: THREE.Vector3, b: THREE.Vector3) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function refreshFootTarget(
  current: THREE.Vector3,
  target: THREE.Vector3,
  floorY: number,
  floorClearance: number,
  reset: boolean,
  delta: number,
  footLock = 1,
) {
  const targetY = floorY + floorClearance;
  if (reset || footHorizontalDistance(current, target) > AVATAR_IK_MAX_FOOT_TARGET_DRIFT) {
    target.set(current.x, targetY, current.z);
    return;
  }
  const unlocked = 1 - THREE.MathUtils.clamp(footLock, 0, 1);
  if (unlocked > 0.001) {
    const followAmount = (delta <= 0 ? 1 : 1 - Math.exp(-18 * delta)) * unlocked;
    target.x = THREE.MathUtils.lerp(target.x, current.x, followAmount);
    target.z = THREE.MathUtils.lerp(target.z, current.z, followAmount);
  }
  const amount = delta <= 0 ? 1 : 1 - Math.exp(-12 * delta);
  target.y = THREE.MathUtils.lerp(target.y, targetY, amount);
}

function rotateIkBoneTowardTarget(
  bone: THREE.Bone | undefined,
  effector: THREE.Bone | undefined,
  target: THREE.Vector3,
  grounding: AvatarGroundingState,
  weight: number,
) {
  if (!bone || !effector || !bone.parent) {
    return;
  }
  bone.getWorldPosition(grounding.jointWorld);
  effector.getWorldPosition(grounding.effectorWorld);
  grounding.effectorDirection.copy(grounding.effectorWorld).sub(grounding.jointWorld);
  grounding.targetDirection.copy(target).sub(grounding.jointWorld);
  if (grounding.effectorDirection.lengthSq() < 0.00001 || grounding.targetDirection.lengthSq() < 0.00001) {
    return;
  }
  grounding.effectorDirection.normalize();
  grounding.targetDirection.normalize();
  grounding.worldDelta.setFromUnitVectors(grounding.effectorDirection, grounding.targetDirection);
  grounding.identityQuaternion.identity().slerp(grounding.worldDelta, THREE.MathUtils.clamp(weight, 0, 1));
  bone.parent.getWorldQuaternion(grounding.parentQuaternion);
  grounding.parentQuaternionInverse.copy(grounding.parentQuaternion).invert();
  grounding.localDelta
    .copy(grounding.parentQuaternionInverse)
    .multiply(grounding.identityQuaternion)
    .multiply(grounding.parentQuaternion);
  bone.quaternion.premultiply(grounding.localDelta);
}

function solveLegIk(
  scene: THREE.Object3D,
  grounding: AvatarGroundingState,
  upperLeg: THREE.Bone | undefined,
  lowerLeg: THREE.Bone | undefined,
  foot: THREE.Bone | undefined,
  target: THREE.Vector3,
  weight: number,
) {
  if (!upperLeg || !lowerLeg || !foot) {
    return;
  }
  for (let iteration = 0; iteration < 2; iteration += 1) {
    rotateIkBoneTowardTarget(lowerLeg, foot, target, grounding, weight);
    scene.updateMatrixWorld(true);
    rotateIkBoneTowardTarget(upperLeg, foot, target, grounding, weight * 0.82);
    scene.updateMatrixWorld(true);
  }
}

function applyAvatarLowerBodyIk(
  scene: THREE.Object3D,
  rig: AvatarRig | null,
  grounding: AvatarGroundingState,
  state: AnimationState,
  floorY: number,
  floorClearance: number,
  delta: number,
  placementAt: number,
  leftFootLock = 1,
  rightFootLock = 1,
) {
  if (!rig?.leftUpperLeg || !rig.leftLowerLeg || !rig.leftFoot || !rig.rightUpperLeg || !rig.rightLowerLeg || !rig.rightFoot) {
    return;
  }

  scene.updateMatrixWorld(true);
  rig.leftFoot.getWorldPosition(grounding.leftFootWorld);
  rig.rightFoot.getWorldPosition(grounding.rightFootWorld);
  const resetTargets =
    !grounding.footTargetsInitialized ||
    Math.abs(grounding.lastPlacementAt - placementAt) > 0.5 ||
    !Number.isFinite(grounding.lastPlacementAt);

  refreshFootTarget(
    grounding.leftFootWorld,
    grounding.leftFootTarget,
    floorY,
    floorClearance,
    resetTargets,
    delta,
    leftFootLock,
  );
  refreshFootTarget(
    grounding.rightFootWorld,
    grounding.rightFootTarget,
    floorY,
    floorClearance,
    resetTargets,
    delta,
    rightFootLock,
  );
  grounding.footTargetsInitialized = true;
  grounding.lastPlacementAt = placementAt;

  const baseIkWeight = state === "sitting" ? 0.86 : 0.62;
  const minIkWeight = state === "sitting" ? 0.72 : 0.36;
  const leftIkWeight = THREE.MathUtils.lerp(
    minIkWeight,
    baseIkWeight,
    THREE.MathUtils.smoothstep(leftFootLock, 0.2, 0.92),
  );
  const rightIkWeight = THREE.MathUtils.lerp(
    minIkWeight,
    baseIkWeight,
    THREE.MathUtils.smoothstep(rightFootLock, 0.2, 0.92),
  );
  solveLegIk(
    scene,
    grounding,
    rig.leftUpperLeg,
    rig.leftLowerLeg,
    rig.leftFoot,
    grounding.leftFootTarget,
    leftIkWeight,
  );
  solveLegIk(
    scene,
    grounding,
    rig.rightUpperLeg,
    rig.rightLowerLeg,
    rig.rightFoot,
    grounding.rightFootTarget,
    rightIkWeight,
  );
}

function stabilizeAvatarGrounding(
  scene: THREE.Object3D,
  rig: AvatarRig | null,
  grounding: AvatarGroundingState,
  floorY: number,
  floorClearance: number,
  floorResponse: number,
  delta: number,
) {
  scene.updateMatrixWorld(true);
  grounding.bounds.setFromObject(scene);
  grounding.bounds.getCenter(grounding.center);
  grounding.bounds.getSize(grounding.size);

  const rigMinY = sampleLowestRigBoneY(rig, grounding);
  const meshMinY = grounding.bounds.isEmpty() ? Number.POSITIVE_INFINITY : grounding.bounds.min.y;
  const measuredMinY = rigMinY ?? meshMinY;
  if (!Number.isFinite(measuredMinY)) {
    grounding.smoothedLift = 0;
    grounding.lastMeasuredMinY = Number.POSITIVE_INFINITY;
    return;
  }

  grounding.lastMeasuredMinY = measuredMinY;
  const targetLift = THREE.MathUtils.clamp(
    floorY + floorClearance - measuredMinY,
    -AVATAR_GROUND_MAX_DROP,
    AVATAR_GROUND_MAX_LIFT,
  );
  const amount = delta <= 0 ? 1 : 1 - Math.exp(-floorResponse * delta);
  grounding.smoothedLift = THREE.MathUtils.lerp(grounding.smoothedLift, targetLift, amount);
  if (Math.abs(grounding.smoothedLift) > 0.0005) {
    scene.position.y += grounding.smoothedLift;
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
        forceYukiHairMaterialsBlack(vrm.scene);
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
      forceYukiHairMaterialsBlack(gltf.scene);
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
    return "No active workers yet. Ask Hermes to open Claude, Codex, or Kimi and they will appear here in-space.";
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

function xrUiPreviewEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("xrUiPreview") === "1";
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
    return "No workers need intervention yet. Hermes is free to open Claude, Codex, or Kimi when you ask.";
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
    return "No active workers yet. Ask Hermes to open Claude, Codex, or Kimi and the board will show their live task, phase, and decisions here.";
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

function buildAgentActivityBoard(
  leadSession: CodingSessionSnapshot | undefined,
  sessions: CodingSessionSnapshot[],
  activityEvents: AgentWireEvent[],
) {
  const lines: string[] = [];
  if (leadSession) {
    lines.push(hermesSessionNarration(leadSession));
  }
  sessions
    .filter((session) => session.sessionId !== leadSession?.sessionId)
    .slice(0, 2)
    .forEach((session) => {
      lines.push(hermesSessionNarration(session));
    });
  activityEvents
    .filter((event) => event.session_id || event.type.startsWith("terminal.") || event.type.startsWith("worker."))
    .slice(0, 4)
    .forEach((event) => {
      lines.push(agentActivityEventLine(event));
    });
  return lines.length > 0
    ? lines.map((line, index) => `${index + 1}. ${line}`).join("  ")
    : "No worker stream yet. When Hermes launches Claude, Codex, or Kimi, live activity appears here.";
}

function latestSessionPreviewLine(session: CodingSessionSnapshot): string | undefined {
  return (
    session.screenText
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-1)[0] ??
    session.outputTail.map((line) => line.trim()).filter(Boolean).slice(-1)[0] ??
    session.lastUpdate ??
    session.managerSummary ??
    session.statusText ??
    undefined
  );
}

function agentActivityEventLine(event: AgentWireEvent): string {
  const workerLabel = payloadText(event.payload, "worker_label") ?? signalLabel(event);
  const line = payloadText(event.payload, "line");
  const screen = payloadText(event.payload, "screen_text")
    ?.split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(-1)[0];
  const summary = compactText(line ?? screen ?? summarizeSignal(event), event.type.replaceAll(".", " "), 140);
  return `${formatEventTime(event.ts)} ${workerLabel}: ${summary}`;
}

function buildActivityRows(
  leadSession: CodingSessionSnapshot | undefined,
  sessions: CodingSessionSnapshot[],
  activityEvents: AgentWireEvent[],
) {
  const ordered = orderedXrSessions(leadSession, sessions);
  const rows = ordered.slice(0, 4).map((session) => {
    const preview = latestSessionPreviewLine(session);
    const label = `${session.workerLabel ?? session.title} · ${normalizeWorkerStatus(session)}`;
    const detail =
      preview ??
      session.taskTitle ??
      session.command ??
      "Waiting for terminal activity.";
    return { label, detail };
  });

  if (rows.length > 0) {
    return rows;
  }

  return activityEvents
    .filter((event) => event.session_id || event.type.startsWith("terminal.") || event.type.startsWith("worker."))
    .slice(0, 4)
    .map((event) => ({
      label: `${formatEventTime(event.ts)} · ${event.type.replaceAll(".", " ")}`,
      detail: agentActivityEventLine(event),
    }));
}

function orderedXrSessions(
  leadSession: CodingSessionSnapshot | undefined,
  sessions: CodingSessionSnapshot[],
) {
  const ordered: CodingSessionSnapshot[] = [];
  if (leadSession) {
    ordered.push(leadSession);
  }
  sessions.forEach((session) => {
    if (!ordered.some((entry) => entry.sessionId === session.sessionId)) {
      ordered.push(session);
    }
  });
  return ordered;
}

function sessionLiveLine(session: CodingSessionSnapshot): string | undefined {
  return (
    session.screenText?.split(/\r?\n/).filter(Boolean).slice(-1)[0] ??
    session.outputTail.slice(-1)[0] ??
    session.lastUpdate ??
    session.managerSummary
  );
}

function hermesSessionNarration(session: CodingSessionSnapshot): string {
  const name = session.workerLabel ?? session.title;
  if (session.waitingOnUser) {
    return `I need your answer for ${name}: ${compactText(session.pendingQuestion, "the worker is waiting on a decision.", 160)}`;
  }
  if (session.workerPhase === "blocked" || session.status === "failed") {
    return `I found a blocker in ${name}: ${compactText(session.blockedReason ?? session.managerSummary, "the worker needs inspection.", 160)}`;
  }
  if (session.needsReview) {
    return `I have ${name} ready for review. ${compactText(session.managerSummary ?? session.lastUpdate, "Review the worker result before we move on.", 150)}`;
  }
  const liveLine = sessionLiveLine(session);
  return `I am tracking ${name}: ${compactText(liveLine, session.taskTitle ?? "the worker is making progress.", 170)}`;
}

function hermesEventNarration(event: AgentWireEvent): string {
  const summary = summarizeSignal(event);
  if (event.type === "worker.updated") {
    return `Worker update: ${summary}`;
  }
  if (event.type === "worker.pending_question") {
    return `I need your input: ${summary}`;
  }
  if (event.type === "terminal.finished") {
    return `A session finished: ${summary}`;
  }
  if (event.type === "terminal.failed") {
    return `A session failed: ${summary}`;
  }
  if (event.type === "assistant.reply" || event.type === "hermes.status" || event.type === "agent.summary") {
    return summary;
  }
  return `${event.type.replaceAll(".", " ")}: ${summary}`;
}

function buildHermesConversation({
  leadSession,
  sessions,
  signalEvents,
  latestTranscript,
  latestSummary,
  subtitle,
}: {
  leadSession: CodingSessionSnapshot | undefined;
  sessions: CodingSessionSnapshot[];
  signalEvents: AgentWireEvent[];
  latestTranscript?: string;
  latestSummary: string;
  subtitle: string;
}): HermesChatMessage[] {
  const messages: HermesChatMessage[] = [];
  const cleanedTranscript = latestTranscript?.replace(/\s+/g, " ").trim();
  const hermesReply =
    leadSession
      ? hermesSessionNarration(leadSession)
      : sessions[0]
        ? hermesSessionNarration(sessions[0])
        : latestSummary ?? subtitle;
  const workerSignal =
    leadSession?.pendingQuestion ??
    leadSession?.blockedReason ??
    leadSession?.taskTitle ??
    sessions.find((session) => session.waitingOnUser || session.needsReview)?.pendingQuestion ??
    sessions[0]?.lastUpdate;

  messages.push({
    speaker: "user",
    label: "You",
    text: cleanedTranscript
      ? compactText(cleanedTranscript, "No recent voice transcript.", 170)
      : "Say a request or reply; Hermes will keep the thread visible here.",
  });

  messages.push({
    speaker: "hermes",
    label: "Hermes",
    text: compactText(hermesReply, "Standing by. I will surface the next worker decision here.", 210),
  });

  sessions.slice(0, 4).forEach((session) => {
    if (session.sessionId === leadSession?.sessionId) {
      return;
    }
    messages.push({
      speaker: "worker",
      label: session.workerLabel ?? session.title,
      text: hermesSessionNarration(session),
    });
  });

  signalEvents
    .slice(0, 14)
    .reverse()
    .forEach((event) => {
      messages.push({
        speaker: event.session_id ? "worker" : "hermes",
        label: `${formatEventTime(event.ts)} ${signalLabel(event)}`,
        text: compactText(hermesEventNarration(event), event.type.replaceAll(".", " "), 220),
      });
    });

  if (workerSignal) {
    messages.push({
      speaker: "worker",
      label: leadSession?.workerLabel ?? sessions[0]?.workerLabel ?? "Worker signal",
      text: compactText(workerSignal, "Worker status is updating.", 180),
    });
  }

  if (leadSession?.waitingOnUser) {
    messages.push({
      speaker: "hermes",
      label: "Hermes next",
      text: `Reply to ${leadSession.workerLabel ?? leadSession.title}; I will route the answer back to the worker.`,
    });
  } else if (sessions.length > 0) {
    messages.push({
      speaker: "hermes",
      label: "Hermes next",
      text: `${sessions.length} worker${sessions.length === 1 ? "" : "s"} live. Select this panel to compact or expand the chat deck.`,
    });
  }

  return messages;
}

function buildActionBoard(
  leadSession: CodingSessionSnapshot | undefined,
  sessions: CodingSessionSnapshot[],
  xrState: XRState,
  avatarStatus: AvatarLoadState,
  deckMode: XrDeckMode,
  deckAnchor: XrDeckAnchor,
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

  if (deckMode === "hidden") {
    return [
      "XR panels are hidden.",
      `${liveCount} live · ${pendingCount} pending · ${blockedCount} blocked.`,
      `Select this handle to show panels. Deck anchor: ${deckAnchor}.`,
    ].join(" ");
  }

  return [
    `${liveCount} live · ${pendingCount} pending · ${blockedCount} blocked.`,
    `XR ${xrStatusTitle(xrState).toLowerCase()}. Avatar ${avatarStatusTitle(avatarStatus).toLowerCase()}.`,
    `Deck ${deckMode} · ${deckAnchor}. Trigger clicks; rail, edge, or corner grab moves a panel.`,
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
  const phoneLabel = phoneBodyRuntimeLabel();
  switch (status) {
    case "ready":
      return isPhoneLaunchSession() ? `${phoneLabel} ready` : "XR ready on Quest";
    case "entering":
      return "Entering XR";
    case "active":
      return "XR session live";
    case "unsupported":
      return isPhoneLaunchSession() ? `${phoneLabel} staged view` : "XR unavailable here";
    case "failed":
      return "XR entry failed";
    default:
      return "Checking XR support";
  }
}

function xrDeckStatusSummary(status: XRState, message: string): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "entering":
      return "Requesting session";
    case "active":
      return "Session live";
    case "unsupported":
      return isPhoneLaunchSession() ? `${phoneBodyRuntimeLabel()} staged view` : "Unsupported here";
    case "failed":
      return message ? "Needs attention" : "Entry failed";
    default:
      return "Checking support";
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

function isPhoneLaunchSession(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("phone") === "1" || params.get("mode") === "phone" || params.get("xrbody") === "1";
  } catch {
    return false;
  }
}

function requestedPhonePlatform(): "android" | "ios" | "auto" {
  try {
    const params = new URLSearchParams(window.location.search);
    const platform = (params.get("platform") ?? params.get("mobilePlatform") ?? "auto").toLowerCase();
    return platform === "android" || platform === "ios" ? platform : "auto";
  } catch {
    return "auto";
  }
}

function detectedPhonePlatform(): "android" | "ios" | "phone" {
  if (/Android/i.test(navigator.userAgent)) {
    return "android";
  }
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return "ios";
  }
  return "phone";
}

function phoneLaunchPlatformLabel(): string {
  const platform = requestedPhonePlatform();
  const resolved = platform === "auto" ? detectedPhonePlatform() : platform;
  switch (resolved) {
    case "android":
      return "Android";
    case "ios":
      return "iPhone";
    default:
      return "Phone";
  }
}

function phoneBodyRuntimeLabel(): string {
  return `${phoneLaunchPlatformLabel()} XR Body`;
}

function applySceneMode(scene: THREE.Scene, mode: SessionMode | null) {
  if (mode === SessionMode.ImmersiveAR) {
    scene.background = null;
    scene.fog = null;
    return;
  }

  if (isDesktopPreviewSession()) {
    scene.background = new THREE.Color(DESKTOP_SCENE_BACKGROUND);
    scene.fog = new THREE.Fog(DESKTOP_SCENE_FOG, 3.4, 8.2);
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
  runtime.auraRing.visible = false;
}

function applyDesktopPreviewLayout(runtime: StageRuntime) {
  runtime.xrUiRoot.position.set(0, 0, 0);
  runtime.xrUiRoot.quaternion.identity();
  runtime.xrUiRoot.scale.setScalar(1);
  runtime.camera.position.copy(DESKTOP_STAGE_LAYOUT.cameraPosition);
  runtime.camera.lookAt(DESKTOP_STAGE_LAYOUT.cameraLookAt);
  runtime.floor.material.color.set(0xe8f2ff);
  runtime.floor.material.metalness = 0;
  runtime.floor.material.roughness = 0.82;
  runtime.platform.material.color.set(0x4c8cff);
  runtime.platform.material.opacity = 0.1;
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
  return !runtime?.world.session && (isLoopbackHost(window.location.hostname) || Boolean(runtime?.desktopPreview));
}

function deriveCameraAngles(camera: THREE.PerspectiveCamera) {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  const yaw = Math.atan2(-direction.x, -direction.z);
  const pitch = Math.asin(THREE.MathUtils.clamp(direction.y, -0.85, 0.85));
  return { yaw, pitch };
}

function createPreviewLocomotionState(camera: THREE.PerspectiveCamera): PreviewLocomotionState {
  camera.updateMatrixWorld(true);
  const { yaw, pitch } = deriveCameraAngles(camera);
  return {
    keys: new Set(),
    position: camera.position.clone(),
    defaultPosition: camera.position.clone(),
    iwerDefaultPosition: new THREE.Vector3(0, 1.6, 0),
    iwerDefaultCaptured: false,
    yaw,
    pitch,
    defaultYaw: yaw,
    defaultPitch: pitch,
    iwerDefaultYaw: 0,
    iwerDefaultPitch: 0,
    resetRequested: false,
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    move: new THREE.Vector3(),
    euler: new THREE.Euler(0, 0, 0, "YXZ"),
    quaternion: new THREE.Quaternion(),
  };
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']")) || target.isContentEditable;
}

function previewKeyAxis(keys: Set<string>, negativeCodes: string[], positiveCodes: string[]): number {
  const negative = negativeCodes.some((code) => keys.has(code)) ? 1 : 0;
  const positive = positiveCodes.some((code) => keys.has(code)) ? 1 : 0;
  return positive - negative;
}

function hasPreviewMotionInput(controls: PreviewLocomotionState): boolean {
  return (
    controls.resetRequested ||
    previewKeyAxis(controls.keys, ["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"]) !== 0 ||
    previewKeyAxis(controls.keys, ["KeyA"], ["KeyD"]) !== 0 ||
    previewKeyAxis(controls.keys, ["KeyQ", "ArrowLeft"], ["KeyE", "ArrowRight"]) !== 0 ||
    previewKeyAxis(controls.keys, ["KeyC", "PageDown"], ["Space", "PageUp"]) !== 0
  );
}

function applyPlanarPreviewMotion(controls: PreviewLocomotionState, delta: number) {
  const forwardInput = previewKeyAxis(controls.keys, ["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"]);
  const strafeInput = previewKeyAxis(controls.keys, ["KeyA"], ["KeyD"]);
  const turnInput = previewKeyAxis(controls.keys, ["KeyQ", "ArrowLeft"], ["KeyE", "ArrowRight"]);
  const verticalInput = previewKeyAxis(controls.keys, ["KeyC", "PageDown"], ["Space", "PageUp"]);
  const speed = controls.keys.has("ShiftLeft") || controls.keys.has("ShiftRight") ? PREVIEW_FAST_SPEED : PREVIEW_WALK_SPEED;

  controls.yaw -= turnInput * PREVIEW_TURN_SPEED * delta;
  controls.forward.set(-Math.sin(controls.yaw), 0, -Math.cos(controls.yaw));
  controls.right.set(Math.cos(controls.yaw), 0, -Math.sin(controls.yaw));
  controls.move.set(0, 0, 0);
  controls.move.addScaledVector(controls.forward, forwardInput);
  controls.move.addScaledVector(controls.right, strafeInput);
  if (controls.move.lengthSq() > 0) {
    controls.move.normalize().multiplyScalar(speed * delta);
    controls.position.add(controls.move);
  }
  controls.position.y = THREE.MathUtils.clamp(
    controls.position.y + verticalInput * PREVIEW_VERTICAL_SPEED * delta,
    0.35,
    2.45,
  );
}

function setIwerVector3(target: IwerVector3Like, value: THREE.Vector3) {
  if (typeof target.set === "function") {
    target.set(value.x, value.y, value.z);
    return;
  }
  target.x = value.x;
  target.y = value.y;
  target.z = value.z;
}

function setIwerQuaternion(target: IwerQuaternionLike, value: THREE.Quaternion) {
  if (typeof target.set === "function") {
    target.set(value.x, value.y, value.z, value.w);
    return;
  }
  target.x = value.x;
  target.y = value.y;
  target.z = value.z;
  target.w = value.w;
}

function syncPreviewControlsFromIwerDevice(controls: PreviewLocomotionState, device: IwerDeviceLike) {
  if (!device.position || !device.quaternion) {
    return false;
  }

  controls.position.set(device.position.x, device.position.y, device.position.z);
  controls.quaternion.set(device.quaternion.x, device.quaternion.y, device.quaternion.z, device.quaternion.w);
  controls.euler.setFromQuaternion(controls.quaternion, "YXZ");
  controls.yaw = controls.euler.y;
  controls.pitch = THREE.MathUtils.clamp(controls.euler.x, -0.8, 0.8);

  if (!controls.iwerDefaultCaptured) {
    controls.iwerDefaultPosition.copy(controls.position);
    controls.iwerDefaultYaw = controls.yaw;
    controls.iwerDefaultPitch = controls.pitch;
    controls.iwerDefaultCaptured = true;
  }

  return true;
}

function updateIwerPreviewLocomotion(controls: PreviewLocomotionState, delta: number): boolean {
  const device = window.IWER_DEVICE;
  if (!device?.position || !device.quaternion || !syncPreviewControlsFromIwerDevice(controls, device)) {
    return false;
  }

  if (controls.resetRequested) {
    controls.position.copy(controls.iwerDefaultPosition);
    controls.yaw = controls.iwerDefaultYaw;
    controls.pitch = controls.iwerDefaultPitch;
    controls.resetRequested = false;
  } else {
    applyPlanarPreviewMotion(controls, delta);
  }

  controls.euler.set(controls.pitch, controls.yaw, 0, "YXZ");
  controls.quaternion.setFromEuler(controls.euler);
  setIwerVector3(device.position, controls.position);
  setIwerQuaternion(device.quaternion, controls.quaternion);
  device.notifyStateChange?.();
  return true;
}

function updateDesktopPreviewLocomotion(
  runtime: StageRuntime,
  controls: PreviewLocomotionState | null,
  delta: number,
  desktopPreviewActive: boolean,
  emulatorXrSession: boolean,
) {
  if (!controls || !hasPreviewMotionInput(controls)) {
    return;
  }

  if (emulatorXrSession) {
    updateIwerPreviewLocomotion(controls, delta);
    return;
  }

  if (!desktopPreviewActive) {
    controls.resetRequested = false;
    return;
  }

  if (controls.resetRequested) {
    controls.position.copy(controls.defaultPosition);
    controls.yaw = controls.defaultYaw;
    controls.pitch = controls.defaultPitch;
    controls.resetRequested = false;
  } else {
    applyPlanarPreviewMotion(controls, delta);
  }

  controls.euler.set(controls.pitch, controls.yaw, 0, "YXZ");
  runtime.camera.position.copy(controls.position);
  runtime.camera.quaternion.setFromEuler(controls.euler);
}

function requestXrUiRecenter(runtime: StageRuntime, clearManualPlacement = true) {
  if (clearManualPlacement) {
    runtime.xrUi.manualPlacement = false;
    clearXrPanelManualPlacement(runtime.xrUi);
    clearXrUiPendingPress(runtime.xrUi);
    clearXrUiDrag(runtime.xrUi);
  }
  runtime.xrUi.recenterRequested = true;
}

function nextXrDeckModeValue(mode: XrDeckMode): XrDeckMode {
  if (mode === "expanded") {
    return "compact";
  }
  return "expanded";
}

function nextXrDeckAnchorValue(anchor: XrDeckAnchor): XrDeckAnchor {
  if (anchor === "front") {
    return "right";
  }
  if (anchor === "right") {
    return "left";
  }
  return "front";
}

function xrDeckModeButtonLabel(mode: XrDeckMode) {
  if (mode === "expanded") {
    return "Minimize XR panels";
  }
  return "Restore XR panels";
}

function clampXrUiTargetToUserSpace(placement: XrUiPlacementState, target: THREE.Vector3) {
  const desiredY = target.y;
  const horizontal = target.clone().sub(placement.cameraPosition);
  horizontal.y = 0;
  const distance = horizontal.length();
  if (distance > 0.0001) {
    horizontal.normalize();
    if (distance < XR_UI_MIN_DISTANCE) {
      target.copy(placement.cameraPosition).addScaledVector(horizontal, XR_UI_MIN_DISTANCE);
    } else if (distance > XR_UI_MAX_DISTANCE) {
      target.copy(placement.cameraPosition).addScaledVector(horizontal, XR_UI_MAX_DISTANCE);
    }
  }
  target.y = THREE.MathUtils.clamp(desiredY, XR_UI_MIN_HEIGHT, XR_UI_MAX_HEIGHT);
}

function resolveAssistantAnchorPosition(
  runtime: StageRuntime,
  activeXrSession: boolean,
  desktopPreviewActive: boolean,
  emulatorXrSession: boolean,
  target: THREE.Vector3,
) {
  const assistantBaseY = emulatorXrSession
    ? IWER_SIM_AVATAR_FLOOR_LIFT
    : runtime.sceneMode === SessionMode.ImmersiveAR
      ? 0
      : desktopPreviewActive
        ? DESKTOP_STAGE_LAYOUT.assistantY
        : ASSISTANT_BASE_Y;
  const defaultAssistantZ = activeXrSession
    ? emulatorXrSession
      ? IWER_SIM_STAGE_DEPTH
      : ACTIVE_XR_STAGE_DEPTH
    : desktopPreviewActive
      ? DESKTOP_STAGE_LAYOUT.assistantZ
      : STAGE_DEPTH;
  const defaultAssistantX = activeXrSession && !emulatorXrSession ? ACTIVE_XR_ASSISTANT_SIDE_X : 0;
  const placement = runtime.avatarPlacement;
  const placementX = placement.hasUserPlacement ? placement.anchorPosition.x : defaultAssistantX;
  const placementY = placement.hasUserPlacement ? placement.anchorPosition.y : 0;
  const placementZ = placement.hasUserPlacement ? placement.anchorPosition.z : defaultAssistantZ;
  return target.set(placementX, assistantBaseY + placementY, placementZ);
}

function resolveYukiAnchoredXrUiPose(
  runtime: StageRuntime,
  activeXrSession: boolean,
  desktopPreviewActive: boolean,
  emulatorXrSession: boolean,
  deckAnchor: XrDeckAnchor,
) {
  const placement = runtime.xrUi;
  resolveAssistantAnchorPosition(
    runtime,
    activeXrSession,
    desktopPreviewActive,
    emulatorXrSession,
    placement.yukiAnchorPosition,
  );

  placement.yukiAnchorToCamera.copy(placement.cameraPosition).sub(placement.yukiAnchorPosition);
  placement.yukiAnchorToCamera.y = 0;
  if (placement.yukiAnchorToCamera.lengthSq() < 0.0001) {
    placement.yukiAnchorToCamera.copy(placement.cameraForward).multiplyScalar(-1);
  } else {
    placement.yukiAnchorToCamera.normalize();
  }

  placement.yukiAnchorRight
    .set(placement.yukiAnchorToCamera.z, 0, -placement.yukiAnchorToCamera.x)
    .normalize();

  const sideSign = deckAnchor === "right" ? 1 : deckAnchor === "left" ? -1 : 0;
  placement.targetPosition.copy(placement.yukiAnchorPosition);
  if (sideSign !== 0) {
    placement.targetPosition.addScaledVector(placement.yukiAnchorRight, sideSign * XR_UI_YUKI_SIDE_OFFSET);
  }
  placement.targetPosition.addScaledVector(placement.yukiAnchorToCamera, -XR_UI_YUKI_BEHIND_OFFSET);
  placement.targetPosition.y = THREE.MathUtils.clamp(
    placement.yukiAnchorPosition.y + XR_UI_YUKI_MIN_HEIGHT_OVER_ROOT,
    XR_UI_MIN_HEIGHT,
    XR_UI_MAX_HEIGHT,
  );
  clampXrUiTargetToUserSpace(placement, placement.targetPosition);

  placement.yukiAnchorToCamera.copy(placement.cameraPosition).sub(placement.targetPosition);
  placement.yukiAnchorToCamera.y = 0;
  if (placement.yukiAnchorToCamera.lengthSq() < 0.0001) {
    placement.yukiAnchorToCamera.copy(placement.cameraForward).multiplyScalar(-1);
  } else {
    placement.yukiAnchorToCamera.normalize();
  }
  const yaw = Math.atan2(placement.yukiAnchorToCamera.x, placement.yukiAnchorToCamera.z);
  placement.cameraEuler.set(0, yaw, 0);
  placement.targetQuaternion.setFromEuler(placement.cameraEuler);
}

function updateXrUiManualDrag(runtime: StageRuntime, delta: number) {
  const placement = runtime.xrUi;
  if (!placement.dragSource) {
    updateXrUiPendingPress(runtime);
  }
  const source = placement.dragSource;
  if (!source) {
    return false;
  }
  const dragPanel = placement.dragPanel;
  if (!dragPanel) {
    clearXrUiDrag(placement);
    return false;
  }

  sourceWorldRay(source, placement.sourcePosition, placement.sourceDirection);
  const inputSource = controllerInputSource(source);
  const axes = bestGamepadAxisPair(inputSource?.gamepad);
  if (axes) {
    const amount = THREE.MathUtils.clamp(delta, 0, 1 / 20);
    placement.dragDistanceOffset = THREE.MathUtils.clamp(
      placement.dragDistanceOffset - axes.y * XR_UI_DRAG_THUMBSTICK_SPEED * amount,
      -0.62,
      0.74,
    );
    placement.dragHeightOffset = THREE.MathUtils.clamp(
      placement.dragHeightOffset + axes.x * XR_UI_DRAG_THUMBSTICK_SPEED * 0.54 * amount,
      -0.42,
      0.42,
    );
  }

  const dragDistance = THREE.MathUtils.clamp(
    placement.dragDistance + placement.dragDistanceOffset,
    XR_UI_MIN_DISTANCE,
    XR_UI_MAX_DISTANCE,
  );
  placement.targetPosition
    .copy(placement.sourcePosition)
    .addScaledVector(placement.sourceDirection, dragDistance)
    .add(placement.dragOffset);
  placement.targetPosition.y += placement.dragHeightOffset;
  clampXrUiTargetToUserSpace(placement, placement.targetPosition);

  setXrPanelWorldPosition(runtime, dragPanel, placement.targetPosition);
  if (placement.targetPosition.distanceTo(placement.dragStartPosition) > XR_UI_TAP_MOVE_THRESHOLD) {
    placement.dragMoved = true;
  }
  rememberXrPanelManualTransform(runtime, dragPanel);
  placement.manualPlacement = true;
  placement.recenterRequested = false;
  return true;
}

function applyXrPanelLayoutPose(
  runtime: StageRuntime,
  panel: XrPanelKey,
  visible: boolean,
  position: readonly [number, number, number],
  scale: number,
  rotation: readonly [number, number, number],
) {
  const placement = runtime.xrUi;
  const panelMesh = runtime.panels[panel].mesh;
  panelMesh.visible = visible;
  panelMesh.scale.setScalar(scale);
  if (placement.panelManualPlacement[panel]) {
    panelMesh.position.copy(placement.panelManualPositions[panel]);
    panelMesh.quaternion.copy(placement.panelManualQuaternions[panel]);
    return;
  }
  panelMesh.position.set(...position);
  panelMesh.rotation.set(...rotation);
}

function updateXrUiPlacement(
  runtime: StageRuntime,
  activeXrSession: boolean,
  desktopPreviewActive: boolean,
  emulatorXrSession: boolean,
  deckMode: XrDeckMode,
  deckAnchor: XrDeckAnchor,
  panelDisplay: Record<XrPanelKey, XrPanelDisplayMode>,
  delta: number,
) {
  const previewXrUi = desktopPreviewActive && xrUiPreviewEnabled();
  if (!activeXrSession && !previewXrUi) {
    return;
  }

  const placement = runtime.xrUi;
  runtime.camera.updateMatrixWorld(true);
  runtime.camera.getWorldPosition(placement.cameraPosition);
  runtime.camera.getWorldQuaternion(placement.cameraQuaternion);
  runtime.camera.getWorldDirection(placement.cameraForward);
  placement.cameraForward.y = 0;
  if (placement.cameraForward.lengthSq() < 0.0001) {
    placement.cameraForward.set(0, 0, -1);
  } else {
    placement.cameraForward.normalize();
  }
  placement.cameraRight.set(-placement.cameraForward.z, 0, placement.cameraForward.x).normalize();

  if (updateXrUiManualDrag(runtime, delta)) {
    // Dragging owns only the grabbed panel transform until squeeze release.
  } else if (placement.manualPlacement && !placement.recenterRequested) {
    runtime.xrUiRoot.position.copy(placement.manualPosition);
    runtime.xrUiRoot.quaternion.copy(placement.manualQuaternion);
  } else {
    resolveYukiAnchoredXrUiPose(runtime, activeXrSession, desktopPreviewActive, emulatorXrSession, deckAnchor);
    runtime.xrUiRoot.position.copy(placement.targetPosition);
    runtime.xrUiRoot.quaternion.copy(placement.targetQuaternion);
    placement.manualPosition.copy(runtime.xrUiRoot.position);
    placement.manualQuaternion.copy(runtime.xrUiRoot.quaternion);
    placement.manualPlacement = true;
    placement.recenterRequested = false;
  }

  runtime.xrUiRoot.scale.setScalar(
    deckMode === "expanded"
      ? XR_UI_EXPANDED_SCALE
      : deckMode === "compact"
        ? XR_UI_COMPACT_SCALE
        : XR_UI_HIDDEN_SCALE,
  );
  const panelScale = (panel: XrPanelKey, baseScale: number) =>
    panelDisplay[panel] === "minimized" ? baseScale * XR_PANEL_MINIMIZED_SCALE : baseScale;

  if (deckMode === "hidden") {
    applyXrPanelLayoutPose(runtime, "summary", false, [-XR_UI_SIDE_PANEL_X, XR_UI_SIDE_PANEL_Y, 0.02], panelScale("summary", 0.72), [
      0,
      0.1,
      0,
    ]);
    applyXrPanelLayoutPose(runtime, "worker", false, [0, XR_UI_CENTER_PANEL_Y, 0], panelScale("worker", 1.02), [0, 0, 0]);
    applyXrPanelLayoutPose(runtime, "status", true, [0, XR_UI_STATUS_Y + 0.04, 0.04], panelScale("status", 0.72), [0, 0, 0]);
    return;
  }
  if (deckMode === "compact") {
    applyXrPanelLayoutPose(runtime, "summary", false, [-XR_UI_SIDE_PANEL_X, XR_UI_SIDE_PANEL_Y, 0.02], panelScale("summary", 0.72), [
      0,
      0.1,
      0,
    ]);
    applyXrPanelLayoutPose(runtime, "worker", true, [0, XR_UI_CENTER_PANEL_Y + 0.02, 0], panelScale("worker", 0.92), [0, 0, 0]);
    applyXrPanelLayoutPose(runtime, "status", true, [0, XR_UI_STATUS_Y + 0.08, 0.04], panelScale("status", 0.78), [0, 0, 0]);
    return;
  }

  applyXrPanelLayoutPose(runtime, "summary", true, [-XR_UI_SIDE_PANEL_X, XR_UI_SIDE_PANEL_Y, 0.02], panelScale("summary", 0.72), [
    0,
    0.1,
    0,
  ]);
  applyXrPanelLayoutPose(runtime, "worker", true, [0, XR_UI_CENTER_PANEL_Y, 0], panelScale("worker", 1.02), [0, 0, 0]);
  applyXrPanelLayoutPose(runtime, "status", true, [XR_UI_SIDE_PANEL_X, XR_UI_SIDE_PANEL_Y, 0.02], panelScale("status", 0.72), [
    0,
    -0.1,
    0,
  ]);
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
    case "sitting":
      return "Yuki has chosen a stable low surface and is sitting.";
    default:
      return "Yuki is idling while Hermes monitors the workspace.";
  }
}

function motionProfile(state: AnimationState) {
  switch (state) {
    case "sitting":
      return {
        bobAmplitude: 0.004,
        bobSpeed: 0.75,
        swayAmplitude: 0.035,
        swaySpeed: 0.5,
        lean: -0.02,
        ringPulse: 0.04,
        ringSpeed: 1.6,
        ringOpacity: 0.7,
        shellPulse: 0.06,
        shellOpacity: 0.13,
        shellSpeed: 1.4,
        beaconPulse: 0.14,
        beaconSpeed: 2,
        beaconIntensity: 1.45,
        lightIntensity: 1.72,
        headTilt: 0.04,
        jitter: 0,
        shoulderRoll: 0.02,
        focusLift: 0,
      };
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
  signalEvents,
  activityEvents,
  micAvailable,
  micActive,
  onToggleMic,
  onLiveContext,
  leadSession,
  sessions,
}: ImmersiveHermesStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<StageRuntime | null>(null);
  const previewControlsRef = useRef<PreviewLocomotionState | null>(null);
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
  const leadSessionRef = useRef(leadSession);
  const sessionsRef = useRef(sessions);
  const signalEventsRef = useRef(signalEvents);
  const activityEventsRef = useRef(activityEvents);
  const seenSpatialObjectEventsRef = useRef<Set<string>>(new Set());
  const micAvailableRef = useRef(micAvailable);
  const micActiveRef = useRef(micActive);
  const onToggleMicRef = useRef(onToggleMic);
  const onLiveContextRef = useRef(onLiveContext);
  const liveContextSnapshotRef = useRef<Record<string, unknown>>({});
  const placementModeRef = useRef(false);
  const xrDeckModeRef = useRef<XrDeckMode>("expanded");
  const xrDeckAnchorRef = useRef<XrDeckAnchor>("front");
  const xrSelectedPanelRef = useRef<XrPanelKey>("worker");
  const xrPanelDisplayRef = useRef<Record<XrPanelKey, XrPanelDisplayMode>>({
    summary: "open",
    worker: "open",
    status: "open",
  });
  const xrJoystickPanelNextAtRef = useRef(0);
  const xrJoystickScrollNextAtRef = useRef(0);
  const xrTerminalScrollRef = useRef(0);
  const xrChatScrollRef = useRef(0);
  const xrFocusIndexRef = useRef(0);
  const xrVoiceToggleNextAtRef = useRef(0);
  const xrHandPinchActiveRef = useRef<Record<XrLogicalHandedness, boolean>>({
    left: false,
    right: false,
  });
  const xrControllerPressActiveRef = useRef<Record<XrLogicalHandedness, boolean>>({
    left: false,
    right: false,
  });
  const spatialBehaviorDebugAtRef = useRef(0);
  const spatialScanDebugAtRef = useRef(0);
  const pendingEnterXrRef = useRef(false);

  const [avatarStatus, setAvatarStatus] = useState<AvatarLoadState>("loading");
  const [avatarMessage, setAvatarMessage] = useState(
    isPhoneLaunchSession()
      ? `Loading Yuki for the ${phoneBodyRuntimeLabel()} surface. Hermes can still drive the stage if Yuki falls back.`
      : "Loading the Quest-stage VRM. Hermes can still drive the stage if Yuki falls back.",
  );
  const [xrState, setXrState] = useState<XRState>("checking");
  const [xrMessage, setXrMessage] = useState(
    "Checking whether this browser can enter immersive mode safely.",
  );
  const [placementMode, setPlacementMode] = useState(false);
  const [xrDeckMode, setXrDeckMode] = useState<XrDeckMode>("expanded");
  const [xrDeckAnchor, setXrDeckAnchor] = useState<XrDeckAnchor>("front");
  const [xrSelectedPanel, setXrSelectedPanel] = useState<XrPanelKey>("worker");
  const [xrPanelDisplay, setXrPanelDisplay] = useState<Record<XrPanelKey, XrPanelDisplayMode>>({
    summary: "open",
    worker: "open",
    status: "open",
  });
  const [xrTerminalScroll, setXrTerminalScroll] = useState(0);
  const [xrChatScroll, setXrChatScroll] = useState(0);
  const [xrFocusIndex, setXrFocusIndex] = useState(0);
  const [placementMessage, setPlacementMessage] = useState(
    "Place Yuki in front of you, then use spatial scans for smarter behavior.",
  );
  const [spatialBehaviorDebug, setSpatialBehaviorDebug] = useState<YukiBehaviorPlannerState>(() =>
    createYukiBehaviorPlannerState(),
  );
  const [spatialScanDebug, setSpatialScanDebug] = useState<SpatialScanSummary>({
    status: "waiting",
    message: "Room scan has not started yet.",
    scannedSurfaceCount: 0,
    floorCount: 0,
    seatCount: 0,
    tableCount: 0,
    blockedCount: 0,
    planeObservations: 0,
    objectBoxObservations: 0,
  });
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
    leadSessionRef.current = leadSession;
    sessionsRef.current = sessions;
  }, [leadSession, sessions]);

  useEffect(() => {
    onLiveContextRef.current = onLiveContext;
  }, [onLiveContext]);

  useEffect(() => {
    signalEventsRef.current = signalEvents;
    activityEventsRef.current = activityEvents;
    const runtime = runtimeRef.current;
    if (runtime) {
      ingestSpatialObjectEvents(
        runtime,
        [...signalEvents, ...activityEvents],
        seenSpatialObjectEventsRef.current,
      );
    }
  }, [signalEvents, activityEvents]);

  useEffect(() => {
    micAvailableRef.current = micAvailable;
  }, [micAvailable]);

  useEffect(() => {
    micActiveRef.current = micActive;
  }, [micActive]);

  useEffect(() => {
    onToggleMicRef.current = onToggleMic;
  }, [onToggleMic]);

  useEffect(() => {
    const focusSessions = orderedXrSessions(leadSession, sessions);
    if (focusSessions.length === 0 && xrFocusIndexRef.current !== 0) {
      xrFocusIndexRef.current = 0;
      setXrFocusIndex(0);
      return;
    }
    if (focusSessions.length > 0 && xrFocusIndexRef.current >= focusSessions.length) {
      const next = focusSessions.length - 1;
      xrFocusIndexRef.current = next;
      setXrFocusIndex(next);
    }
  }, [leadSession, sessions]);

  const setPlacementModeActive = (active: boolean) => {
    placementModeRef.current = active;
    setPlacementMode(active);
  };

  const setXrDeckModeActive = (mode: XrDeckMode) => {
    xrDeckModeRef.current = mode;
    setXrDeckMode(mode);
    const runtime = runtimeRef.current;
    if (runtime && !runtime.xrUi.manualPlacement) {
      requestXrUiRecenter(runtime, false);
    }
  };

  const setXrDeckAnchorActive = (anchor: XrDeckAnchor) => {
    xrDeckAnchorRef.current = anchor;
    setXrDeckAnchor(anchor);
    const runtime = runtimeRef.current;
    if (runtime) {
      requestXrUiRecenter(runtime);
    }
  };

  const toggleXrDeckMode = () => {
    setXrDeckModeActive(nextXrDeckModeValue(xrDeckModeRef.current));
  };

  const cycleXrDeckAnchor = () => {
    setXrDeckAnchorActive(nextXrDeckAnchorValue(xrDeckAnchorRef.current));
  };

  const setXrSelectedPanelActive = (panel: XrPanelKey) => {
    xrSelectedPanelRef.current = panel;
    setXrSelectedPanel(panel);
  };

  const toggleXrPanelMinimized = (panel: XrPanelKey) => {
    setXrPanelDisplay((current) => {
      const nextMode: XrPanelDisplayMode = current[panel] === "minimized" ? "open" : "minimized";
      const next = {
        ...current,
        [panel]: nextMode,
      };
      xrPanelDisplayRef.current = next;
      setPlacementMessage(
        nextMode === "minimized"
          ? `${xrPanelFocusLabel(panel)} minimized into a HUD tile.`
          : `${xrPanelFocusLabel(panel)} restored.`,
      );
      return next;
    });
    setXrSelectedPanelActive(panel);
  };

  const cycleXrSelectedPanel = (direction: 1 | -1) => {
    const currentIndex = Math.max(0, XR_PANEL_ORDER.indexOf(xrSelectedPanelRef.current));
    const nextPanel = XR_PANEL_ORDER[THREE.MathUtils.euclideanModulo(currentIndex + direction, XR_PANEL_ORDER.length)];
    setXrSelectedPanelActive(nextPanel);
    if (xrDeckModeRef.current !== "expanded") {
      setXrDeckModeActive("expanded");
    }
  };

  const scrollXrTerminal = (direction: 1 | -1) => {
    const next = THREE.MathUtils.clamp(xrTerminalScrollRef.current + direction * 6, 0, 96);
    xrTerminalScrollRef.current = next;
    setXrTerminalScroll(next);
  };

  const scrollXrChat = (direction: 1 | -1) => {
    const next = THREE.MathUtils.clamp(xrChatScrollRef.current + direction * 2, 0, 64);
    xrChatScrollRef.current = next;
    setXrChatScroll(next);
  };

  const setXrFocusIndexActive = (index: number) => {
    const focusSessions = orderedXrSessions(leadSessionRef.current, sessionsRef.current);
    const next = focusSessions.length > 0 ? THREE.MathUtils.euclideanModulo(index, focusSessions.length) : 0;
    xrFocusIndexRef.current = next;
    xrTerminalScrollRef.current = 0;
    setXrFocusIndex(next);
    setXrTerminalScroll(0);
  };

  const cycleXrFocus = (direction: 1 | -1) => {
    setXrFocusIndexActive(xrFocusIndexRef.current + direction);
  };

  const scrollXrSelectedPanel = (direction: 1 | -1) => {
    if (xrDeckModeRef.current !== "expanded") {
      setXrDeckModeActive("expanded");
    }
    const selectedPanel = xrSelectedPanelRef.current;
    if (selectedPanel === "summary") {
      scrollXrChat(direction);
      return;
    }
    if (selectedPanel === "status") {
      cycleXrFocus(direction);
      return;
    }
    scrollXrTerminal(direction);
  };

  const updateXrJoystickPanelControls = (runtime: StageRuntime) => {
    if (!runtime.world.session || placementModeRef.current || runtime.xrUi.dragSource || runtime.xrUi.pendingSource) {
      return;
    }

    const now = performance.now();
    const leftAxes = bestGamepadAxisPair(xrInputSourceForHand(runtime, "left")?.gamepad);
    const leftDirection = dominantJoystickDirection(leftAxes);
    const leftMagnitude = Math.max(Math.abs(leftAxes?.x ?? 0), Math.abs(leftAxes?.y ?? 0));
    if (leftDirection !== 0 && now >= xrJoystickPanelNextAtRef.current) {
      cycleXrSelectedPanel(leftDirection);
      xrJoystickPanelNextAtRef.current = now + XR_JOYSTICK_REPEAT_MS;
    } else if (leftMagnitude <= XR_JOYSTICK_AXIS_RELEASE) {
      xrJoystickPanelNextAtRef.current = Math.min(xrJoystickPanelNextAtRef.current, now);
    }

    const rightAxes = bestGamepadAxisPair(xrInputSourceForHand(runtime, "right")?.gamepad);
    const rightY = rightAxes?.y ?? 0;
    if (Math.abs(rightY) >= XR_JOYSTICK_AXIS_THRESHOLD && now >= xrJoystickScrollNextAtRef.current) {
      scrollXrSelectedPanel(rightY > 0 ? 1 : -1);
      xrJoystickScrollNextAtRef.current = now + XR_JOYSTICK_REPEAT_MS;
    } else if (Math.abs(rightY) <= XR_JOYSTICK_AXIS_RELEASE) {
      xrJoystickScrollNextAtRef.current = Math.min(xrJoystickScrollNextAtRef.current, now);
    }
  };

  function handlePlaceYuki() {
    const runtime = runtimeRef.current;
    if (!runtime) {
      setPlacementMessage("Yuki placement will be available once the XR stage finishes loading.");
      return;
    }

    const activeRealXrSession = Boolean(runtime.world.session) && !hasLocalDesktopXrEmulator();
    if (activeRealXrSession) {
      setPlacementModeActive(true);
      setPlacementMessage("Aim at the floor or a low surface and press select to place Yuki.");
      return;
    }

    const target = placeAvatarFromCamera(runtime);
    setPlacementModeActive(false);
    setPlacementMessage(placementSummary(target));
  }

  function finishPlacementFromSource(source: THREE.Object3D) {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return false;
    }
    const result = placeAvatarFromSource(runtime, source);
    setPlacementModeActive(false);
    setPlacementMessage(placementSummary(result));
    return true;
  }

  function placeYukiAtBestAffordance(kind: "seat" | "table") {
    const runtime = runtimeRef.current;
    if (!runtime) {
      setPlacementMessage("Scene-aware placement will be available once the XR stage finishes loading.");
      return;
    }
    const minStability = kind === "seat" ? YUKI_AUTONOMOUS_SEAT_STABILITY : YUKI_AUTONOMOUS_TABLE_STABILITY;
    const affordance = runtime.spatialAffordances.best(kind, minStability);
    if (!affordance) {
      setPlacementMessage(
        kind === "seat"
          ? "No stable scanned seat yet. Aim at a chair or couch with Place Yuki, or enable stage debug to inspect affordance rings."
          : "No stable scanned table yet. Let plane detection settle, then aim at the surface or try again.",
      );
      return;
    }
    applyAvatarPlacement(runtime, affordance.center, { source: "manual", affordance });
    setPlacementModeActive(false);
    setPlacementMessage(
      placementSummary({
        target: avatarAnchorForSurface(affordance.center, affordance),
        surfaceTarget: affordance.center.clone(),
        affordance,
      }),
    );
  }

  function requestXrVoiceToggle(sourceLabel = "xr-stage") {
    const now = performance.now();
    if (now < xrVoiceToggleNextAtRef.current) {
      return true;
    }
    xrVoiceToggleNextAtRef.current = now + 450;
    const runtime = runtimeRef.current;
    if (runtime) {
      runtime.wristMic.pressPulseUntil = now + 260;
      runtime.xrUi.lastPointerEventAt = now;
      runtime.xrUi.lastPointerEventLabel = "Voice toggle requested";
      setPlacementMessage(micActiveRef.current ? "Stopping realtime voice." : "Starting realtime voice.");
    }
    const event = new CustomEvent(XR_VOICE_TOGGLE_EVENT, {
      cancelable: true,
      detail: { source: sourceLabel },
    });
    const handledByApp = !window.dispatchEvent(event);
    if (!handledByApp) {
      onToggleMicRef.current();
    }
    return true;
  }

  function handleXrNativeControlAction(action: XrNativeControlAction) {
    const runtime = runtimeRef.current;
    if (action !== "toggle-deck") {
      setXrSelectedPanelActive("status");
    }
    switch (action) {
      case "place-yuki":
        handlePlaceYuki();
        return true;
      case "use-seat":
        placeYukiAtBestAffordance("seat");
        return true;
      case "stand-table":
        placeYukiAtBestAffordance("table");
        return true;
      case "toggle-mic":
        return requestXrVoiceToggle("xr-status-panel");
      case "toggle-deck":
        toggleXrDeckMode();
        return true;
      case "toggle-panel-minimized":
        return false;
      case "follow-anchor":
        cycleXrDeckAnchor();
        if (runtime) {
          requestXrUiRecenter(runtime);
        }
        return true;
      case "next-worker":
        cycleXrFocus(1);
        return true;
      case "previous-worker":
        cycleXrFocus(-1);
        return true;
    }
  }

  function beginXrPanelPointerInteraction(
    source: THREE.Object3D,
    pointer: XrPointerVisual | undefined,
    pointerKind: XrPanelPointerKind,
    options: { allowDeckToggle?: boolean } = {},
  ) {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return false;
    }
    if (placementModeRef.current) {
      if (pointerKind === "select" && finishPlacementFromSource(source)) {
        return true;
      }
      runtime.xrUi.lastPointerMissAt = performance.now();
      runtime.xrUi.lastPointerEventAt = runtime.xrUi.lastPointerMissAt;
      runtime.xrUi.lastPointerEventLabel = "Only select places Yuki";
      return false;
    }
    if (pointerKind !== "squeeze" && runtime.xrUi.dragSource) {
      return false;
    }
    const panelDetail = currentXrPointerHit(runtime, source, pointer);
    if (panelDetail) {
      const panelHit = panelDetail.key;
      const panelMinimized = xrPanelDisplayRef.current[panelHit] === "minimized";
      const action =
        panelMinimized && pointerKind !== "squeeze"
          ? "toggle-panel-minimized"
          : xrPanelClickAction(panelDetail, xrDeckModeRef.current);
      setXrSelectedPanelActive(panelHit);
      if (pointerKind === "squeeze") {
        if (xrPanelHitCanMovePanel(panelDetail)) {
          startXrUiDeckDrag(runtime, source, panelHit, {
            pointerKind,
            clickAction: action,
            hit: panelDetail,
            suppressClick: true,
          });
        } else {
          runtime.xrUi.lastPointerEventAt = performance.now();
          runtime.xrUi.lastPointerEventLabel =
            panelDetail.zone === "window-control"
              ? "Use trigger on the window button"
              : `Grab the ${xrPanelFocusLabel(panelHit)} rail, edge, or corner to move it`;
        }
      } else {
        if (action === "toggle-mic") {
          handleXrNativeControlAction(action);
          return true;
        }
        startXrUiDeckPress(runtime, source, panelHit, {
          pointerKind,
          clickAction: action,
          hit: panelDetail,
        });
      }
      return true;
    }
    runtime.xrUi.lastPointerMissAt = performance.now();
    runtime.xrUi.lastPointerEventAt = runtime.xrUi.lastPointerMissAt;
    runtime.xrUi.lastPointerEventLabel = "Trigger missed panels";
    if (options.allowDeckToggle && xrDeckModeRef.current === "hidden") {
      toggleXrDeckMode();
      return true;
    }
    return false;
  }

  function handleXrPanelQuickTap(panel: XrPanelKey, clickAction: XrNativeControlAction | null) {
    if (clickAction === "toggle-panel-minimized") {
      toggleXrPanelMinimized(panel);
      return true;
    }
    if (clickAction && handleXrNativeControlAction(clickAction)) {
      return true;
    }
    setXrSelectedPanelActive(panel);
    if (panel === "worker" && xrDeckModeRef.current === "expanded") {
      scrollXrTerminal(1);
      return true;
    }
    if (panel === "summary" && xrDeckModeRef.current === "expanded") {
      scrollXrChat(1);
      return true;
    }
    if (panel === "status" && xrDeckModeRef.current === "expanded") {
      cycleXrFocus(1);
      return true;
    }
    toggleXrDeckMode();
    return true;
  }

  function finishXrPanelPointerInteraction(
    source: THREE.Object3D,
    pointerKind: XrPanelPointerKind,
    pointer?: XrPointerVisual,
  ) {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return false;
    }
    const releaseHit =
      pointerKind === "pinch"
        ? handHitXrPanelDetail(runtime, source as XRHandSpaceLike)
        : sourceRayHitXrPanelDetail(runtime, source) ?? sourceTouchXrPanelDetail(runtime, source) ?? pointer?.lastHit ?? null;
    const result =
      endXrUiDeckPress(runtime, source, pointerKind) ??
      endXrUiDeckDrag(runtime, source, pointerKind);
    if (!result) {
      return false;
    }
    if (result.shouldClick && result.panel) {
      if (result.clickAction === "toggle-panel-minimized") {
        handleXrPanelQuickTap(result.panel, result.clickAction);
        return true;
      }
      const samePanelReleaseHit = releaseHit?.key === result.panel ? releaseHit : null;
      const releaseAction = samePanelReleaseHit ? xrNativeControlActionAt(samePanelReleaseHit) : null;
      if (result.clickAction) {
        if (!releaseAction || releaseAction === result.clickAction) {
          handleXrPanelQuickTap(result.panel, result.clickAction);
        }
        return true;
      }
      if (!samePanelReleaseHit) {
        handleXrPanelQuickTap(result.panel, null);
        return true;
      }
      if (releaseAction) {
        return true;
      }
      handleXrPanelQuickTap(samePanelReleaseHit.key, null);
    }
    return true;
  }

  function xrGamepadPrimaryPressed(inputSource: XRInputSource | null | undefined) {
    const buttons = inputSource?.gamepad?.buttons;
    return Boolean(buttons?.some((button) => button.pressed));
  }

  function controllerTargetsVoice(runtime: StageRuntime, controller: THREE.Object3D, pointer?: XrPointerVisual) {
    if (
      runtime.wristMic.group.visible &&
      (sourceRayHitsWristMic(runtime.wristMic, controller) ||
        sourceTouchesWristMic(runtime.wristMic, controller, WRIST_MIC_TOUCH_RADIUS * 1.35))
    ) {
      return true;
    }
    const hit = currentXrPointerHit(runtime, controller, pointer);
    return Boolean(hit && xrNativeControlActionAt(hit) === "toggle-mic");
  }

  function updateXrVoiceInputPolling(runtime: StageRuntime) {
    ([
      ["left", runtime.leftHand],
      ["right", runtime.rightHand],
    ] as Array<[XrLogicalHandedness, XRHandSpaceLike]>).forEach(([handedness, hand]) => {
      const pinching = Boolean(hand.inputState?.pinching);
      const wasPinching = xrHandPinchActiveRef.current[handedness];
      xrHandPinchActiveRef.current[handedness] = pinching;
      if (
        pinching &&
        !wasPinching &&
        runtime.wristMic.group.visible &&
        handTouchesWristMic(runtime.wristMic, hand)
      ) {
        requestXrVoiceToggle(`xr-${handedness}-hand-pinch`);
      }
    });

    xrControllerEntries(runtime).forEach(({ controller, pointer }) => {
      const inputSource = controllerInputSource(controller);
      const handedness = xrInputSourceHandedness(inputSource);
      if (!handedness) {
        return;
      }
      const pressed = xrGamepadPrimaryPressed(inputSource);
      const wasPressed = xrControllerPressActiveRef.current[handedness];
      xrControllerPressActiveRef.current[handedness] = pressed;
      if (pressed && !wasPressed && controllerTargetsVoice(runtime, controller, pointer)) {
        requestXrVoiceToggle(`xr-${handedness}-controller-button`);
      }
    });
  }

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const controls = previewControlsRef.current;
      if (!controls || !PREVIEW_CONTROL_KEYS.has(event.code) || isEditableEventTarget(event.target)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.code === "KeyP") {
        handlePlaceYuki();
      } else if (event.code === "KeyR") {
        controls.resetRequested = true;
      } else {
        controls.keys.add(event.code);
      }
      event.preventDefault();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      previewControlsRef.current?.keys.delete(event.code);
    };

    const clearKeys = () => {
      previewControlsRef.current?.keys.clear();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearKeys);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearKeys);
    };
  }, []);

  async function checkXRSupport() {
    const probeToken = ++xrProbeTokenRef.current;
    if (!mountedRef.current) {
      return;
    }

    const phoneLabel = phoneBodyRuntimeLabel();
    setXrState("checking");
    setXrMessage("Checking WebXR support and secure context requirements.");

    if (!window.isSecureContext && !isLoopbackHost(window.location.hostname)) {
      setXrState("failed");
      setXrMessage(
        isPhoneLaunchSession()
          ? `${phoneLabel} is open, but immersive AR and microphone permissions need a trusted HTTPS URL. Regenerate the QR/cert for this Wi-Fi network, then refresh.`
          : "Quest Browser requires HTTPS or localhost before immersive XR can start.",
      );
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
      setXrMessage(
        isPhoneLaunchSession()
          ? `${phoneLabel} is active. This browser does not expose WebXR, so Yuki stays in the staged mobile view instead of entering camera AR.`
          : "This browser does not expose navigator.xr, so immersive mode cannot start.",
      );
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
        setXrMessage(
          isPhoneLaunchSession()
            ? `${phoneLabel} is active. This browser did not report immersive WebXR support, so Yuki stays in the staged mobile view.`
            : "Immersive VR is not reported as supported in this browser session.",
        );
        return;
      }
      xrModeRef.current = supportsAr ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR;
      setXrState("ready");
      setXrMessage(
        supportsAr
          ? isPhoneLaunchSession()
            ? `${phoneLabel} mixed reality entry is ready. Yuki can use browser AR placement if this ${phoneLaunchPlatformLabel()} browser exposes WebXR AR.`
            : "Mixed reality entry is ready. Quest can try passthrough-style placement first, then fall back to VR if needed."
          : isPhoneLaunchSession()
            ? `${phoneLabel} staged view is ready. Immersive AR will start only if this browser exposes WebXR.`
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
      setXrMessage(stageError);
      return;
    }

    if (xrSessionRef.current) {
      setXrState("active");
      setXrMessage("XR session is already live.");
      return;
    }

    if (xrState === "checking") {
      pendingEnterXrRef.current = true;
      setXrMessage("Enter XR requested. Finishing WebXR support check first.");
      await checkXRSupport();
      return;
    }

    if (xrState === "failed" || xrState === "unsupported") {
      pendingEnterXrRef.current = true;
      setXrMessage("Retrying XR support check, then entering if the browser allows it.");
      await checkXRSupport();
      return;
    }

    if (xrState !== "ready") {
      setXrMessage(`XR is ${xrStatusTitle(xrState).toLowerCase()}; wait a moment and try again.`);
      return;
    }

    const runtime = runtimeRef.current;
    const xr = getXRSystem();
    if (!xr) {
      setXrState("failed");
      setXrMessage(
        isPhoneLaunchSession()
          ? `WebXR is not available on this page. ${phoneBodyRuntimeLabel()} will stay in the staged view unless the phone browser exposes WebXR AR.`
          : "WebXR is not available on this page. On Quest, open the HTTPS Mac LAN URL, accept the certificate warning, then refresh.",
      );
      return;
    }
    if (!runtime) {
      pendingEnterXrRef.current = true;
      setXrMessage("XR stage is still loading. I will enter as soon as it is ready.");
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
      requestXrUiRecenter(runtime);
      await webXRManager.setSession(session);
      runtime.world.session = session;

      if (!mountedRef.current) {
        return;
      }
      setXrState("active");
      setXrMessage(
        sessionMode === SessionMode.ImmersiveAR
          ? isPhoneLaunchSession()
            ? `${phoneBodyRuntimeLabel()} mixed reality session live. Move the phone slowly so Yuki can stabilize floor placement.`
            : "Mixed reality session live. If passthrough looks wrong, recentre from the Quest system menu or retry in VR."
          : isPhoneLaunchSession()
            ? `${phoneBodyRuntimeLabel()} XR session live. Move slowly and keep the companion running on the Mac.`
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
    const handleGlobalEnterXR = () => {
      void enterXR();
    };

    window.__xrAgentEnterXR = handleGlobalEnterXR;
    window.addEventListener("xr-agent-enter-xr", handleGlobalEnterXR);
    return () => {
      if (window.__xrAgentEnterXR === handleGlobalEnterXR) {
        delete window.__xrAgentEnterXR;
      }
      window.removeEventListener("xr-agent-enter-xr", handleGlobalEnterXR);
    };
  }, [stageError, xrState]);

  useEffect(() => {
    if (xrState !== "ready" || !pendingEnterXrRef.current) {
      return;
    }
    pendingEnterXrRef.current = false;
    void enterXR();
  }, [xrState]);

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
    let removeWristMicListeners: (() => void) | null = null;

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
        setStageError(
          isPhoneLaunchSession()
            ? `IWSDK could not initialize the ${phoneBodyRuntimeLabel()} stage: ${detail}`
            : `IWSDK could not initialize the Quest stage: ${detail}`,
        );
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
        setStageError(
          isPhoneLaunchSession()
            ? `The ${phoneBodyRuntimeLabel()} WebGL context was lost. Waiting for the browser to restore the stage.`
            : "The Quest WebGL context was lost. Waiting for the browser to restore the stage.",
        );
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
          depthWrite: false,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.045;
      floor.renderOrder = -20;
      scene.add(floor);

      const platform = new THREE.Mesh(
        new THREE.CircleGeometry(0.7, 48),
        new THREE.MeshBasicMaterial({
          color: 0x1b9cff,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
        }),
      );
      platform.rotation.x = -Math.PI / 2;
      platform.position.y = -0.035;
      platform.renderOrder = -19;
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
        summary: createPanel(new THREE.Vector3(-1.38, 1.02, PANEL_DEPTH), Math.PI / 9, [1.04, 0.74]),
        worker: createPanel(new THREE.Vector3(0, 0.96, PANEL_DEPTH), 0, [1.48, 0.92]),
        status: createPanel(new THREE.Vector3(1.38, 0.96, PANEL_DEPTH), -Math.PI / 9, [1.04, 0.74]),
      };
      const xrUiRoot = new THREE.Group();
      const xrUi = createXrUiPlacementState();
      const xrDiagnostics = createXrInputDiagnosticPanel();
      scene.add(xrUiRoot);
      Object.values(panels).forEach((panel) => {
        xrUiRoot.add(panel.mesh);
      });

      const webXRManager = renderer.xr;
      const leftController = webXRManager.getController(0);
      const rightController = webXRManager.getController(1);
      const leftGrip = webXRManager.getControllerGrip(0);
      const rightGrip = webXRManager.getControllerGrip(1);
      const leftHand = webXRManager.getHand(0) as XRHandSpaceLike;
      const rightHand = webXRManager.getHand(1) as XRHandSpaceLike;
      scene.add(leftController, rightController, leftGrip, rightGrip, leftHand, rightHand);
      const leftPointer = createXrPointerVisual("left-controller-pointer");
      const rightPointer = createXrPointerVisual("right-controller-pointer");
      leftController.add(leftPointer.line);
      rightController.add(rightPointer.line);
      scene.add(leftPointer.cursor, rightPointer.cursor);

      const wristMic = createWristMicControl();
      scene.add(wristMic.group);
      const motionEngine = createYukiMotionEngine();
      const avatarPlacement = createAvatarPlacementState();
      const spatialAffordances = createSpatialAffordanceStore();
      const affordanceDebug = createAffordanceDebugVisuals();
      const spatialScan = createSpatialScanState();
      const spatialBehavior = createYukiBehaviorPlannerState();
      scene.add(avatarPlacement.reticle);
      scene.add(affordanceDebug.group);

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
        xrUiRoot,
        xrUi,
        panels,
        wristMic,
        leftHand,
        rightHand,
        leftGrip,
        rightGrip,
        leftController,
        rightController,
        leftPointer,
        rightPointer,
        xrDiagnostics,
        vrm: null,
        avatarScene: null,
        avatarMode: null,
        avatarRig: null,
        avatarAnimations: null,
        avatarMorphs: null,
        avatarGrounding: createAvatarGroundingState(),
        avatarPlacement,
        spatialAffordances,
        affordanceDebug,
        spatialScan,
        spatialBehavior,
        motionEngine,
      };
      runtimeRef.current = runtime;
      ingestSpatialObjectEvents(
        runtimeRef.current,
        [...signalEventsRef.current, ...activityEventsRef.current],
        seenSpatialObjectEventsRef.current,
      );
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
      previewControlsRef.current = createPreviewLocomotionState(camera);

      const triggerWristMicToggle = () => {
        requestXrVoiceToggle("xr-wrist-mic");
      };
      const addWristMicListener = (
        target: THREE.Object3D,
        eventName: "selectstart" | "selectend" | "pinchstart" | "pinchend" | "squeezestart" | "squeezeend",
        handler: (event: unknown) => void,
        removers: Array<() => void>,
      ) => {
        const eventTarget = target as THREE.Object3D & {
          addEventListener(type: string, listener: (event: unknown) => void): void;
          removeEventListener(type: string, listener: (event: unknown) => void): void;
        };
        const listener = (event: unknown) => {
          rememberInputSourceFromEvent(target, event);
          handler(event);
        };
        eventTarget.addEventListener(eventName, listener);
        removers.push(() => eventTarget.removeEventListener(eventName, listener));
      };
      const wristMicListenerRemovers: Array<() => void> = [];
      [leftController, rightController, leftGrip, rightGrip, leftHand, rightHand].forEach((source) => {
        bindControllerInputSource(source, wristMicListenerRemovers);
      });
      [leftController, rightController].forEach((controller) => {
        addWristMicListener(
          controller,
          "selectstart",
          () => {
            const liveRuntime = runtimeRef.current;
            if (!liveRuntime) {
              return;
            }
            if (placementModeRef.current && finishPlacementFromSource(controller)) {
              return;
            }
            if (
              liveRuntime.wristMic.group.visible &&
              (sourceRayHitsWristMic(liveRuntime.wristMic, controller) ||
                sourceTouchesWristMic(liveRuntime.wristMic, controller))
            ) {
              triggerWristMicToggle();
              return;
            }
            const pointer = xrPointerForController(liveRuntime, controller);
            beginXrPanelPointerInteraction(controller, pointer, "select", { allowDeckToggle: true });
          },
          wristMicListenerRemovers,
        );
        addWristMicListener(
          controller,
          "selectend",
          () => {
            const liveRuntime = runtimeRef.current;
            const pointer = liveRuntime
              ? xrPointerForController(liveRuntime, controller)
              : undefined;
            finishXrPanelPointerInteraction(controller, "select", pointer);
          },
          wristMicListenerRemovers,
        );
        addWristMicListener(
          controller,
          "squeezestart",
          () => {
            const liveRuntime = runtimeRef.current;
            if (liveRuntime) {
              if (placementModeRef.current) {
                liveRuntime.xrUi.lastPointerMissAt = performance.now();
                liveRuntime.xrUi.lastPointerEventAt = liveRuntime.xrUi.lastPointerMissAt;
                liveRuntime.xrUi.lastPointerEventLabel = "Grab ignored during Yuki placement";
                return;
              }
              const panelDetail = currentXrPointerHit(
                liveRuntime,
                controller,
                xrPointerForController(liveRuntime, controller),
              );
              if (panelDetail) {
                const panelHit = panelDetail.key;
                setXrSelectedPanelActive(panelHit);
                if (xrPanelHitCanMovePanel(panelDetail)) {
                  startXrUiDeckDrag(liveRuntime, controller, panelHit, {
                    pointerKind: "squeeze",
                    hit: panelDetail,
                    suppressClick: true,
                  });
                } else {
                  liveRuntime.xrUi.lastPointerEventAt = performance.now();
                  liveRuntime.xrUi.lastPointerEventLabel =
                    panelDetail.zone === "window-control"
                      ? "Use trigger on the window button"
                      : `Grab the ${xrPanelFocusLabel(panelHit)} rail, edge, or corner to move it`;
                }
                return;
              }
              liveRuntime.xrUi.lastPointerMissAt = performance.now();
              liveRuntime.xrUi.lastPointerEventAt = liveRuntime.xrUi.lastPointerMissAt;
              liveRuntime.xrUi.lastPointerEventLabel = "Grab missed panels";
            }
          },
          wristMicListenerRemovers,
        );
        addWristMicListener(
          controller,
          "squeezeend",
          () => {
            const liveRuntime = runtimeRef.current;
            if (liveRuntime) {
              endXrUiDeckDrag(liveRuntime, controller, "squeeze");
            }
          },
          wristMicListenerRemovers,
        );
      });
      const handleHandSelectStart = (hand: XRHandSpaceLike) => {
        const liveRuntime = runtimeRef.current;
        if (!liveRuntime) {
          return;
        }
        if (placementModeRef.current && finishPlacementFromSource(hand)) {
          return;
        }
        if (
          liveRuntime.wristMic.group.visible &&
          handTouchesWristMic(liveRuntime.wristMic, hand)
        ) {
          triggerWristMicToggle();
          return;
        }
        const panelDetail = handHitXrPanelDetail(liveRuntime, hand);
        if (panelDetail) {
          const panelHit = panelDetail.key;
          const action =
            xrPanelDisplayRef.current[panelHit] === "minimized"
              ? "toggle-panel-minimized"
              : xrPanelClickAction(panelDetail, xrDeckModeRef.current);
          setXrSelectedPanelActive(panelHit);
          if (action === "toggle-mic") {
            handleXrNativeControlAction(action);
            return;
          }
          startXrUiDeckPress(liveRuntime, hand, panelHit, {
            pointerKind: "pinch",
            clickAction: action,
            hit: panelDetail,
          });
          return;
        }
        liveRuntime.xrUi.lastPointerMissAt = performance.now();
        liveRuntime.xrUi.lastPointerEventAt = liveRuntime.xrUi.lastPointerMissAt;
        liveRuntime.xrUi.lastPointerEventLabel = "Hand select missed panels";
      };
      const handleHandSelectEnd = (hand: XRHandSpaceLike) => {
        finishXrPanelPointerInteraction(hand, "pinch");
      };

      [leftHand, rightHand].forEach((hand) => {
        addWristMicListener(
          hand,
          "selectstart",
          () => handleHandSelectStart(hand),
          wristMicListenerRemovers,
        );
        addWristMicListener(
          hand,
          "selectend",
          () => handleHandSelectEnd(hand),
          wristMicListenerRemovers,
        );
        addWristMicListener(
          hand,
          "pinchstart",
          () => handleHandSelectStart(hand),
          wristMicListenerRemovers,
        );
        addWristMicListener(
          hand,
          "pinchend",
          () => handleHandSelectEnd(hand),
          wristMicListenerRemovers,
        );
      });
      removeWristMicListeners = () => {
        wristMicListenerRemovers.forEach((remove) => remove());
        wristMicListenerRemovers.length = 0;
      };

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
              : isPhoneLaunchSession()
                ? `Yuki loaded from ${avatar.sourceUrl} with body clips and face morph targets ready for ${phoneBodyRuntimeLabel()} performance.`
                : `Yuki loaded from ${avatar.sourceUrl} with body clips and face morph targets ready for Quest stage performance.`,
          );
        })
        .catch((error: unknown) => {
          console.error(
            isPhoneLaunchSession()
              ? `Failed to load Yuki VRM for ${phoneBodyRuntimeLabel()} stage.`
              : "Failed to load Yuki VRM for Quest stage.",
            error,
          );
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

      const animate = (_time?: number, frame?: XRFrame) => {
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
                ? isPhoneLaunchSession()
                  ? `${phoneBodyRuntimeLabel()} mixed reality session live. Move the phone slowly so Yuki can stabilize floor placement.`
                  : "Mixed reality session live. If passthrough looks wrong, recentre from the Quest system menu or retry in VR."
                : isPhoneLaunchSession()
                  ? `${phoneBodyRuntimeLabel()} XR session live. Move slowly and keep the companion running on the Mac.`
                  : "XR session live. If the floor feels low, recentre from the Quest system menu.",
            );
          }
        }

        const baseAnimationState = deriveAnimationState(
          stateRef.current,
          avatarModeRef.current,
          speechSpeakingRef.current,
        );
        const desktopPreviewActive = isDesktopPreviewActive(live);
        updateSpatialAffordances(live, frame, elapsed, desktopPreviewActive);
        const behaviorPlan = planYukiBehavior({
          baseAnimationState,
          elapsed,
          placement: live.avatarPlacement,
          spatialAffordances: live.spatialAffordances,
          state: live.spatialBehavior,
        });
        if (behaviorPlan.action?.type === "place-at-affordance") {
          applyAvatarPlacement(live, behaviorPlan.action.affordance.center, {
            source: behaviorPlan.action.source,
            affordance: behaviorPlan.action.affordance,
          });
        }
        const animationState = behaviorPlan.animationState;
        if (mountedRef.current && elapsed - spatialScanDebugAtRef.current > 0.35) {
          spatialScanDebugAtRef.current = elapsed;
          setSpatialScanDebug(spatialScanSummary(live));
        }
        if (mountedRef.current && stageDebugEnabled() && elapsed - spatialBehaviorDebugAtRef.current > 0.45) {
          spatialBehaviorDebugAtRef.current = elapsed;
          setSpatialBehaviorDebug({ ...live.spatialBehavior });
        }
        const clipState = mapClipState(animationState);
        const motion = motionProfile(animationState);
        const accent = toneColor(toneRef.current);
        const stateAccentColor = stateAccent(stateRef.current);
        const jitter =
          motion.jitter > 0 ? Math.sin(elapsed * 16) * motion.jitter + Math.cos(elapsed * 11) * motion.jitter * 0.4 : 0;

        const activeXrSession = Boolean(live.world.session);
        const emulatorXrSession = activeXrSession && hasLocalDesktopXrEmulator();
        const yukiMotion = live.motionEngine.update({
          state: animationState,
          delta,
          elapsed,
          speechSpeaking: speechSpeakingRef.current,
          activeXrSession,
          desktopPreviewActive,
          emulatorXrSession,
        });
        updateDesktopPreviewLocomotion(
          live,
          previewControlsRef.current,
          delta,
          desktopPreviewActive,
          emulatorXrSession,
        );
        updateXrUiPlacement(
          live,
          activeXrSession,
          desktopPreviewActive,
          emulatorXrSession,
          xrDeckModeRef.current,
          xrDeckAnchorRef.current,
          xrPanelDisplayRef.current,
          delta,
        );
        xrControllerEntries(live).forEach(({ controller, pointer }) => {
          updateXrPointerVisual(live, controller, pointer, activeXrSession);
        });
        updateXrPanelPointerFeedback(live, activeXrSession);
        updateXrInputDiagnostics(live, activeXrSession);
        updateXrJoystickPanelControls(live);
        updateWristMicPlacement(live, activeXrSession);
        updateXrVoiceInputPolling(live);
        updateWristMicVisual(live.wristMic, micAvailableRef.current, micActiveRef.current, elapsed);
        const assistantBaseY = emulatorXrSession
          ? IWER_SIM_AVATAR_FLOOR_LIFT
          : live.sceneMode === SessionMode.ImmersiveAR
            ? 0
            : desktopPreviewActive
              ? DESKTOP_STAGE_LAYOUT.assistantY
              : ASSISTANT_BASE_Y;
        const placement = live.avatarPlacement;
        const defaultAssistantZ = activeXrSession
          ? emulatorXrSession
            ? IWER_SIM_STAGE_DEPTH
            : ACTIVE_XR_STAGE_DEPTH
          : desktopPreviewActive
            ? DESKTOP_STAGE_LAYOUT.assistantZ
            : STAGE_DEPTH;
        const defaultAssistantX = activeXrSession && !emulatorXrSession ? ACTIVE_XR_ASSISTANT_SIDE_X : 0;
        const placementX = placement.hasUserPlacement ? placement.anchorPosition.x : defaultAssistantX;
        const placementY = placement.hasUserPlacement ? placement.anchorPosition.y : 0;
        const placementZ = placement.hasUserPlacement ? placement.anchorPosition.z : defaultAssistantZ;
        live.assistantRoot.position.x = placementX + yukiMotion.rootOffset.x;
        live.assistantRoot.position.y = assistantBaseY + placementY + yukiMotion.rootOffset.y;
        live.assistantRoot.rotation.y = yukiMotion.rootRotation.y + (animationState === "alert" ? jitter * 0.12 : 0);
        live.assistantRoot.rotation.x = yukiMotion.rootRotation.x;
        live.assistantRoot.rotation.z = yukiMotion.rootRotation.z;
        live.assistantRoot.position.z = placementZ + yukiMotion.rootOffset.z;
        live.platform.material.opacity = 0.12 + Math.max(0, Math.sin(elapsed * 2.8)) * 0.08;
        live.auraRing.visible = false;
        live.auraShell.visible = !activeXrSession && !desktopPreviewActive;
        live.beacon.visible = !activeXrSession && !desktopPreviewActive;
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
        live.lookTarget.position.y = THREE.MathUtils.clamp(live.lookTarget.position.y, 1.16, 1.42);

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
          const basePresenceScale =
            typeof live.avatarScene.userData.basePresenceScale === "number"
              ? live.avatarScene.userData.basePresenceScale
              : 1;
          const avatarScaleBoost = activeXrSession
            ? emulatorXrSession
              ? IWER_SIM_AVATAR_SCALE_BOOST
              : ACTIVE_XR_AVATAR_SCALE_BOOST
            : desktopPreviewActive
              ? DESKTOP_STAGE_LAYOUT.avatarScaleBoost
              : 1;
          const avatarFloorLift = activeXrSession
            ? emulatorXrSession
              ? 0
              : ACTIVE_XR_AVATAR_FLOOR_LIFT
            : desktopPreviewActive
              ? DESKTOP_PREVIEW_AVATAR_FLOOR_LIFT
              : PREVIEW_AVATAR_FLOOR_LIFT;
          live.avatarScene.scale.setScalar(basePresenceScale * avatarScaleBoost);
          live.avatarScene.position.y = avatarFloorLift;
          live.avatarScene.position.z = desktopPreviewActive ? DESKTOP_STAGE_LAYOUT.avatarZOffset : 0;
        }

        if (live.avatarAnimations && !live.fallbackRig.group.visible) {
          setAvatarClipState(
            live.avatarAnimations,
            clipState,
            yukiMotion.clipTimeScale,
            yukiMotion.clipCrossFadeSeconds,
          );
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

        if (live.avatarRig && animationState === "sitting" && !live.fallbackRig.group.visible) {
          applyAvatarSeatedPose(live.avatarRig, elapsed, speechSpeakingRef.current);
        }

        if (live.avatarScene && live.avatarRig && !live.fallbackRig.group.visible) {
          applyAvatarLowerBodyIk(
            live.avatarScene,
            live.avatarRig,
            live.avatarGrounding,
            animationState,
            live.avatarPlacement.hasUserPlacement ? live.avatarPlacement.floorY : 0,
            yukiMotion.floorClearance,
            delta,
            live.avatarPlacement.placedAt,
            yukiMotion.leftFootLock,
            yukiMotion.rightFootLock,
          );
        }

        if (live.avatarScene && !live.fallbackRig.group.visible) {
          stabilizeAvatarGrounding(
            live.avatarScene,
            live.avatarRig,
            live.avatarGrounding,
            live.avatarPlacement.hasUserPlacement ? live.avatarPlacement.floorY : 0,
            yukiMotion.floorClearance,
            yukiMotion.floorResponse,
            delta,
          );
        }

        if (emulatorXrSession && live.avatarScene && !live.fallbackRig.group.visible) {
          const previousAutoClear = live.renderer.autoClear;
          live.scene.updateMatrixWorld(true);
          live.avatarScene.visible = false;
          live.renderer.autoClear = previousAutoClear;
          live.renderer.render(live.scene, live.camera);

          const visibilityRestore: Array<[THREE.Object3D, boolean]> = [];
          const keepVisible = new Set<THREE.Object3D>([live.scene, live.assistantRoot, live.avatarScene]);
          for (let parent = live.avatarScene.parent; parent; parent = parent.parent) {
            keepVisible.add(parent);
          }
          live.avatarScene.traverse((object) => keepVisible.add(object));
          live.scene.traverse((object) => {
            const renderObject = object as THREE.Object3D & { isLight?: boolean; isCamera?: boolean };
            const shouldBeVisible = keepVisible.has(object) || Boolean(renderObject.isLight) || Boolean(renderObject.isCamera);
            if (object.visible !== shouldBeVisible) {
              visibilityRestore.push([object, object.visible]);
              object.visible = shouldBeVisible;
            }
          });

          live.renderer.clearDepth();
          live.renderer.autoClear = false;
          live.renderer.render(live.scene, live.camera);
          visibilityRestore.forEach(([object, visible]) => {
            object.visible = visible;
          });
          live.renderer.autoClear = previousAutoClear;
        } else {
          live.renderer.render(live.scene, live.camera);
        }
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
      removeWristMicListeners?.();
      removeWristMicListeners = null;
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
        disposeObjectTree(activeRuntime.xrDiagnostics.mesh);
        disposeObjectTree(activeRuntime.wristMic.group);
        disposeObjectTree(activeRuntime.avatarPlacement.reticle);
        disposeObjectTree(activeRuntime.affordanceDebug.group);
        disposeObjectTree(activeRuntime.floor);
        disposeObjectTree(activeRuntime.platform);
        disposeObjectTree(activeRuntime.assistantRoot);
        disposeObjectTree(activeRuntime.auraRing);
        disposeObjectTree(activeRuntime.auraShell);
        disposeObjectTree(activeRuntime.beacon);
        activeRuntime.renderer.dispose();
      }
      runtimeRef.current = null;
      previewControlsRef.current = null;
      host.replaceChildren();
    };
  }, [stageGeneration]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    const xrSessions = orderedXrSessions(leadSession, sessions);
    const safeFocusIndex =
      xrSessions.length > 0 ? THREE.MathUtils.clamp(xrFocusIndex, 0, xrSessions.length - 1) : 0;
    const xrFocusSession = xrSessions[safeFocusIndex];
    const xrFocusLabel =
      xrSessions.length > 0
        ? `Worker ${safeFocusIndex + 1}/${xrSessions.length}`
        : "No worker selected";

    if (xrDeckMode === "expanded") {
      drawChatPanel(
        runtime.panels.summary,
        buildHermesConversation({
          leadSession,
          sessions,
          signalEvents,
          latestTranscript,
          latestSummary,
          subtitle,
        }),
        {
          tone: leadSession?.waitingOnUser ? "attention" : tone,
          compact: true,
          scrollOffset: xrChatScroll,
        },
      );
      drawTerminalPanel(runtime.panels.worker, xrFocusSession, {
        tone:
          leadSession?.waitingOnUser
            ? "attention"
            : sessions.some((session) => session.workerPhase === "blocked" || session.status === "failed")
              ? "attention"
              : tone,
        scrollOffset: xrTerminalScroll,
        focusLabel: xrFocusLabel,
      });
    } else {
      drawPanel(runtime.panels.summary, {
        eyebrow: "Manager board",
        title: leadSession?.waitingOnUser ? "Decision needed" : title,
        body: buildDecisionBoard(leadSession, sessions),
        tone: leadSession?.waitingOnUser ? "attention" : tone,
      });
      drawChatPanel(
        runtime.panels.worker,
        buildHermesConversation({
          leadSession,
          sessions,
          signalEvents,
          latestTranscript,
          latestSummary,
          subtitle,
        }),
        {
          tone:
            leadSession?.waitingOnUser
              ? "attention"
              : sessions.some((session) => session.workerPhase === "blocked" || session.status === "failed")
                ? "attention"
                : tone,
          compact: xrDeckMode === "compact",
          scrollOffset: xrChatScroll,
        },
      );
    }

    if (xrDeckMode === "expanded") {
      drawActivityPanel(runtime.panels.status, {
        leadSession,
        sessions,
        activityEvents,
        tone:
          leadSession?.waitingOnUser
            ? "attention"
            : sessions.some((session) => session.workerPhase === "blocked" || session.status === "failed")
              ? "attention"
              : tone,
        scanSummary: spatialScanDebug,
        deckMode: xrDeckMode,
        deckAnchor: xrDeckAnchor,
        micAvailable,
        micActive,
      });
    } else {
      drawPanel(runtime.panels.status, {
        eyebrow: "Deck controls",
        title: xrDeckMode === "hidden" ? "Panels hidden" : "Chat minimized",
        body: buildActionBoard(leadSession, sessions, xrState, avatarStatus, xrDeckMode, xrDeckAnchor),
        tone:
          leadSession?.waitingOnUser
            ? "attention"
            : sessions.some((session) => session.workerPhase === "blocked" || session.status === "failed")
              ? "attention"
              : tone,
      });
    }

    (Object.keys(runtime.panels) as XrPanelKey[]).forEach((panelKey) => {
      const minimized = xrPanelDisplay[panelKey] === "minimized";
      if (minimized) {
        drawXrPanelMinimizedHud(runtime.panels[panelKey], panelKey, xrSelectedPanel === panelKey);
      } else {
        drawPanelFocusFrame(
          runtime.panels[panelKey],
          xrSelectedPanel === panelKey,
        );
        drawXrPanelChrome(runtime.panels[panelKey], panelKey, xrSelectedPanel === panelKey, false);
      }
    });

    runtime.auraRing.material.color.setHex(toneColor(tone));
    runtime.auraRing.material.emissive.setHex(stateAccent(characterState));
    runtime.auraShell.material.color.setHex(stateAccent(characterState));
    runtime.auraShell.material.emissive.setHex(stateAccent(characterState));
    runtime.beacon.material.emissive.setHex(stateAccent(characterState));
  }, [
    avatarStatus,
    activityEvents,
    characterState,
    leadSession,
    latestSummary,
    latestTranscript,
    micActive,
    micAvailable,
    signalEvents,
    sessions,
    spatialScanDebug,
    subtitle,
    title,
    tone,
    xrDeckAnchor,
    xrChatScroll,
    xrDeckMode,
    xrFocusIndex,
    xrPanelDisplay,
    xrSelectedPanel,
    xrTerminalScroll,
    xrState,
  ]);

  const xrButtonLabel =
    xrState === "entering"
      ? "Entering XR..."
      : xrState === "active"
        ? "XR Session Live"
        : xrState === "failed" || xrState === "unsupported"
          ? "Recheck XR"
          : xrState === "checking"
            ? "Checking XR..."
            : isPhoneLaunchSession()
              ? "Enter XR Body"
              : "Enter XR on Quest";
  const xrButtonDisabled =
    Boolean(stageError) || xrState === "checking" || xrState === "entering" || xrState === "active";
  const xrStatusMessage = stageError ?? xrMessage;
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
  const baseStageAnimationState = deriveAnimationState(characterState, avatarMode, speechSpeaking);
  const stageAnimationState: AnimationState =
    spatialBehaviorDebug.mode === "sitting" ? "sitting" : baseStageAnimationState;
  const speechPulseAgeMs = speechPulseAt > 0 ? Math.max(0, Date.now() - speechPulseAt) : null;
  const decisionFocus =
    leadSession?.pendingQuestion ??
    leadSession?.managerSummary ??
    latestSummary;
  const focusWorker = leadSession ?? blockedSessions[0] ?? sessions[0];
  const xrFocusSessions = orderedXrSessions(leadSession, sessions);
  const safeXrFocusIndex =
    xrFocusSessions.length > 0 ? THREE.MathUtils.clamp(xrFocusIndex, 0, xrFocusSessions.length - 1) : 0;
  const xrFocusWorker = xrFocusSessions[safeXrFocusIndex];
  const showStageDebug = stageDebugEnabled();

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("xr-agent-xr-status", {
        detail: {
          state: xrState,
          label: xrButtonLabel,
          summary: xrDeckStatusSummary(xrState, xrStatusMessage),
          message: xrStatusMessage,
          canRequest: !xrButtonDisabled,
        },
      }),
    );
  }, [xrButtonDisabled, xrButtonLabel, xrState, xrStatusMessage]);

  useEffect(() => {
    liveContextSnapshotRef.current = {
      xr_state: xrState,
      xr_message: xrStatusMessage,
      avatar_status: avatarStatus,
      avatar_mode: avatarMode,
      animation_state: stageAnimationState,
      speaking: speechSpeaking,
      latest_transcript: latestTranscript,
      deck: {
        mode: xrDeckMode,
        anchor: xrDeckAnchor,
        selected_panel: xrSelectedPanel,
        panels: xrPanelDisplay,
      },
      yuki: {
        placement_mode: placementMode,
        placement_message: placementMessage,
        behavior_mode: spatialBehaviorDebug.mode,
        priority: spatialBehaviorDebug.priority,
        active_affordance_kind: spatialBehaviorDebug.activeAffordanceKind,
        message: spatialBehaviorDebug.message,
      },
      scan: {
        status: spatialScanDebug.status,
        message: spatialScanDebug.message,
        surfaces: spatialScanDebug.scannedSurfaceCount,
        floors: spatialScanDebug.floorCount,
        seats: spatialScanDebug.seatCount,
        tables: spatialScanDebug.tableCount,
        blocked: spatialScanDebug.blockedCount,
        plane_observations: spatialScanDebug.planeObservations,
        object_box_observations: spatialScanDebug.objectBoxObservations,
      },
      workers: {
        total: sessions.length,
        pending: pendingSessions.length,
        blocked: blockedSessions.length,
        review: reviewSessions.length,
        focus: focusWorker
          ? {
              title: focusWorker.title,
              status: focusWorker.status,
              label: focusWorker.workerLabel,
              phase: focusWorker.workerPhase,
              needs_review: focusWorker.needsReview,
              waiting_on_user: focusWorker.waitingOnUser,
              pending_question: focusWorker.pendingQuestion,
              summary: sessionLiveLine(focusWorker) ?? focusWorker.managerSummary ?? focusWorker.lastUpdate,
              stream_preview: sessionLiveLine(focusWorker),
              screen_rows: focusWorker.screenRows,
              screen_columns: focusWorker.screenColumns,
            }
          : null,
      },
    };
  }, [
    avatarMode,
    avatarStatus,
    blockedSessions.length,
    focusWorker,
    latestTranscript,
    pendingSessions.length,
    placementMessage,
    placementMode,
    reviewSessions.length,
    sessions.length,
    spatialBehaviorDebug,
    spatialScanDebug,
    speechSpeaking,
    stageAnimationState,
    xrDeckAnchor,
    xrDeckMode,
    xrPanelDisplay,
    xrSelectedPanel,
    xrState,
    xrStatusMessage,
  ]);

  useEffect(() => {
    const emitLiveContext = () => {
      onLiveContextRef.current?.("quest-xr-stage", liveContextSnapshotRef.current);
    };
    emitLiveContext();
    const timer = window.setInterval(emitLiveContext, 4000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const scanStatusLabel =
    spatialScanDebug.status === "semantic"
      ? "Semantic scan"
      : spatialScanDebug.status === "geometry"
        ? "Geometry scan"
        : "Scan warming";
  const scannedSeatLabel =
    spatialScanDebug.seatCount > 0 ? `Use scanned seat (${spatialScanDebug.seatCount})` : "Use scanned seat";
  const scannedTableLabel =
    spatialScanDebug.tableCount > 0 ? `Stand by table (${spatialScanDebug.tableCount})` : "Stand by table";

  return (
    <div className="presence-stage presence-stage-immersive">
      <div ref={hostRef} className="immersive-stage-canvas" />
      <div className="immersive-stage-overlay">
        <div className="immersive-stage-control-hint" aria-hidden="true">
          <span>Move WASD / arrows</span>
          <span>Turn Q/E</span>
          <span>Height Space/C</span>
          <span>Reset R</span>
          <span>Grab moves UI</span>
          <span>Trigger tap clicks</span>
          <span>{scanStatusLabel}</span>
          <span>Deck {xrDeckMode}</span>
          <span>Anchor {xrDeckAnchor}</span>
          <span>Panel {xrPanelFocusLabel(xrSelectedPanel)}</span>
        </div>
        <div className="immersive-stage-copy">
          <p className="eyebrow">{isPhoneLaunchSession() ? phoneBodyRuntimeLabel() : "Quest XR Stage"}</p>
          <h2>Yuki / Hermes core</h2>
          <p className="immersive-stage-mode-pill">
            Deck {xrDeckMode} · {xrDeckAnchor}
          </p>
          <p className="immersive-stage-mode-pill">
            Focus {xrFocusSessions.length > 0 ? `${safeXrFocusIndex + 1}/${xrFocusSessions.length}` : "none"}
          </p>
          <p className="immersive-stage-mode-pill">Panel {xrPanelFocusLabel(xrSelectedPanel)}</p>
          <p>
            {avatarMode === "listening" || speechSpeaking
              ? "Listening for your instruction."
              : xrFocusWorker
                ? compactText(
                    xrFocusWorker.pendingQuestion ??
                      xrFocusWorker.blockedReason ??
                      xrFocusWorker.managerSummary ??
                      xrFocusWorker.lastUpdate ??
                      xrFocusWorker.taskTitle,
                    "Worker focus active.",
                    96,
                  )
                : "Standing by for the next coding task."}
          </p>
        </div>
        <div className="immersive-stage-placement-dock">
          <button
            type="button"
            className={`quest-xr-button quest-place-button ${placementMode ? "is-active" : ""}`}
            onClick={handlePlaceYuki}
          >
            {placementMode ? "Aim + select" : "Place Yuki"}
          </button>
          <div className="xr-deck-controls">
            <button type="button" className="mini-link-button" onClick={() => placeYukiAtBestAffordance("seat")}>
              {scannedSeatLabel}
            </button>
            <button type="button" className="mini-link-button" onClick={() => placeYukiAtBestAffordance("table")}>
              {scannedTableLabel}
            </button>
            <button type="button" className="mini-link-button" onClick={toggleXrDeckMode}>
              {xrDeckModeButtonLabel(xrDeckMode)}
            </button>
            <button type="button" className="mini-link-button" onClick={cycleXrDeckAnchor}>
              Follow {nextXrDeckAnchorValue(xrDeckAnchor)}
            </button>
            <button type="button" className="mini-link-button" onClick={() => cycleXrFocus(1)}>
              Next worker
            </button>
            <button type="button" className="mini-link-button" onClick={() => cycleXrFocus(-1)}>
              Previous worker
            </button>
            <button type="button" className="mini-link-button" onClick={() => scrollXrTerminal(1)}>
              Terminal older
            </button>
            <button type="button" className="mini-link-button" onClick={() => scrollXrTerminal(-1)}>
              Terminal newer
            </button>
            <button type="button" className="mini-link-button" onClick={() => scrollXrChat(1)}>
              Chat older
            </button>
            <button type="button" className="mini-link-button" onClick={() => scrollXrChat(-1)}>
              Chat newer
            </button>
          </div>
          <p className={`placement-status ${placementMode ? "is-active" : ""}`}>{placementMessage}</p>
          <p className={`placement-status ${spatialScanDebug.status !== "waiting" ? "is-active" : ""}`}>
            {spatialScanDebug.message}
          </p>
        </div>
        <div className="immersive-stage-status-stack">
          {showStageDebug ? (
            <div className="immersive-stage-status-card immersive-stage-debug-card">
              <p className="eyebrow">Stage Debug</p>
              <div className="immersive-debug-grid">
                <span>Animation</span>
                <strong>{stageAnimationState}</strong>
                <span>Planner</span>
                <strong>{spatialBehaviorDebug.mode}</strong>
                <span>Priority</span>
                <strong>{spatialBehaviorDebug.priority}</strong>
                <span>Affordance</span>
                <strong>{spatialBehaviorDebug.activeAffordanceKind ?? "none"}</strong>
                <span>Scan</span>
                <strong>{spatialScanDebug.status}</strong>
                <span>Seats / tables</span>
                <strong>{spatialScanDebug.seatCount} / {spatialScanDebug.tableCount}</strong>
                <span>Hermes mode</span>
                <strong>{avatarMode}</strong>
                <span>Speech</span>
                <strong>{speechSpeaking ? "active" : "idle"}</strong>
                <span>Mic</span>
                <strong>{micAvailable ? (micActive ? "recording" : "ready") : "setup"}</strong>
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
              <p>{spatialBehaviorDebug.message || animationFeedback(stageAnimationState)}</p>
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
            <p className="eyebrow">Hermes Conversation</p>
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
                : compactText(latestTranscript, buildWorkerSummary(sessions), 150)}
            </p>
            <div className="xr-deck-controls">
              <button type="button" className="mini-link-button" onClick={toggleXrDeckMode}>
                {xrDeckModeButtonLabel(xrDeckMode)}
              </button>
              <button type="button" className="mini-link-button" onClick={cycleXrDeckAnchor}>
                Follow {nextXrDeckAnchorValue(xrDeckAnchor)}
              </button>
              <button type="button" className="mini-link-button" onClick={() => cycleXrFocus(1)}>
                Next worker
              </button>
              <button type="button" className="mini-link-button" onClick={() => cycleXrFocus(-1)}>
                Previous worker
              </button>
              <button type="button" className="mini-link-button" onClick={() => scrollXrTerminal(1)}>
                Terminal older
              </button>
              <button type="button" className="mini-link-button" onClick={() => scrollXrTerminal(-1)}>
                Terminal newer
              </button>
              <button type="button" className="mini-link-button" onClick={() => scrollXrChat(1)}>
                Chat older
              </button>
              <button type="button" className="mini-link-button" onClick={() => scrollXrChat(-1)}>
                Chat newer
              </button>
            </div>
          </div>
          {showStageDebug ? (
            <div className={`immersive-stage-status-card ${avatarCardTone}`}>
              <p className="eyebrow">Avatar Runtime</p>
              <strong>{avatarStatusTitle(avatarStatus)}</strong>
              <p>{avatarMessage}</p>
            </div>
          ) : null}
          <div className={`immersive-stage-status-card immersive-stage-xr-card ${xrCardTone}`}>
            <p className="eyebrow">XR Entry</p>
            <strong>{xrStatusTitle(xrState)}</strong>
            <p>{xrStatusMessage}</p>
            <p className={`placement-status ${placementMode ? "is-active" : ""}`}>{placementMessage}</p>
            <p className={`placement-status ${spatialScanDebug.status !== "waiting" ? "is-active" : ""}`}>
              {spatialScanDebug.message}
            </p>
            <div className="xr-button-slot">
              <button
                type="button"
                className={`quest-xr-button quest-place-button ${placementMode ? "is-active" : ""}`}
                onClick={handlePlaceYuki}
              >
                {placementMode ? "Aim + select" : "Place Yuki"}
              </button>
              <button type="button" className="quest-xr-button" onClick={() => placeYukiAtBestAffordance("seat")}>
                {scannedSeatLabel}
              </button>
              <button type="button" className="quest-xr-button" onClick={() => placeYukiAtBestAffordance("table")}>
                {scannedTableLabel}
              </button>
              <button type="button" className="quest-xr-button" onClick={toggleXrDeckMode}>
                {xrDeckModeButtonLabel(xrDeckMode)}
              </button>
              <button type="button" className="quest-xr-button" onClick={cycleXrDeckAnchor}>
                Follow {nextXrDeckAnchorValue(xrDeckAnchor)}
              </button>
              <button type="button" className="quest-xr-button" onClick={() => cycleXrFocus(1)}>
                Next worker
              </button>
              <button type="button" className="quest-xr-button" onClick={() => cycleXrFocus(-1)}>
                Previous worker
              </button>
              <button type="button" className="quest-xr-button" onClick={() => scrollXrTerminal(1)}>
                Terminal older
              </button>
              <button type="button" className="quest-xr-button" onClick={() => scrollXrTerminal(-1)}>
                Terminal newer
              </button>
              <button type="button" className="quest-xr-button" onClick={() => scrollXrChat(1)}>
                Chat older
              </button>
              <button type="button" className="quest-xr-button" onClick={() => scrollXrChat(-1)}>
                Chat newer
              </button>
              <button
                type="button"
                className="quest-xr-button quest-xr-enter-button"
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
