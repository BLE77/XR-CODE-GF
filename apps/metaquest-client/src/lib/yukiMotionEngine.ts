import * as THREE from "three";

export type YukiMotionState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "alert"
  | "ready"
  | "walkStart"
  | "walking"
  | "walkStop"
  | "turnLeft"
  | "turnRight"
  | "sitDown"
  | "sitting"
  | "standUp";

export type YukiMotionIntent = {
  state: YukiMotionState;
  delta: number;
  elapsed: number;
  speechSpeaking: boolean;
  activeXrSession: boolean;
  desktopPreviewActive: boolean;
  emulatorXrSession: boolean;
};

export type YukiMotionFrame = {
  rootOffset: THREE.Vector3;
  rootRotation: THREE.Euler;
  clipTimeScale: number;
  clipCrossFadeSeconds: number;
  floorClearance: number;
  floorResponse: number;
  leftFootLock: number;
  rightFootLock: number;
  stridePhase: number;
  stateWeights: Readonly<Record<YukiMotionState, number>>;
};

type MotionProfile = {
  energy: number;
  attentiveness: number;
  forwardLean: number;
  sideSway: number;
  verticalLift: number;
  pulseSpeed: number;
  strideSpeed: number;
  clipTimeScale: number;
  clipCrossFadeSeconds: number;
  floorClearance: number;
  floorResponse: number;
  plantBias: number;
};

const MOTION_STATES: YukiMotionState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "alert",
  "ready",
  "walkStart",
  "walking",
  "walkStop",
  "turnLeft",
  "turnRight",
  "sitDown",
  "sitting",
  "standUp",
];

const MOTION_PROFILES: Record<YukiMotionState, MotionProfile> = {
  idle: {
    energy: 0.18,
    attentiveness: 0.18,
    forwardLean: 0,
    sideSway: 0.012,
    verticalLift: 0.004,
    pulseSpeed: 0.78,
    strideSpeed: 0.28,
    clipTimeScale: 0.92,
    clipCrossFadeSeconds: 0.38,
    floorClearance: 0.018,
    floorResponse: 11,
    plantBias: 0.86,
  },
  listening: {
    energy: 0.42,
    attentiveness: 0.84,
    forwardLean: -0.035,
    sideSway: 0.025,
    verticalLift: 0.018,
    pulseSpeed: 1.45,
    strideSpeed: 0.62,
    clipTimeScale: 0.98,
    clipCrossFadeSeconds: 0.24,
    floorClearance: 0.026,
    floorResponse: 14,
    plantBias: 0.76,
  },
  thinking: {
    energy: 0.34,
    attentiveness: 0.66,
    forwardLean: -0.018,
    sideSway: 0.02,
    verticalLift: 0.014,
    pulseSpeed: 1.08,
    strideSpeed: 0.46,
    clipTimeScale: 0.84,
    clipCrossFadeSeconds: 0.34,
    floorClearance: 0.026,
    floorResponse: 13,
    plantBias: 0.82,
  },
  speaking: {
    energy: 0.72,
    attentiveness: 0.92,
    forwardLean: -0.045,
    sideSway: 0.032,
    verticalLift: 0.026,
    pulseSpeed: 2.15,
    strideSpeed: 0.84,
    clipTimeScale: 1.08,
    clipCrossFadeSeconds: 0.22,
    floorClearance: 0.03,
    floorResponse: 15,
    plantBias: 0.7,
  },
  alert: {
    energy: 0.86,
    attentiveness: 1,
    forwardLean: -0.018,
    sideSway: 0.01,
    verticalLift: 0.014,
    pulseSpeed: 2.6,
    strideSpeed: 0.96,
    clipTimeScale: 1.14,
    clipCrossFadeSeconds: 0.16,
    floorClearance: 0.034,
    floorResponse: 17,
    plantBias: 0.74,
  },
  ready: {
    energy: 0.24,
    attentiveness: 0.48,
    forwardLean: 0.004,
    sideSway: 0.008,
    verticalLift: 0.008,
    pulseSpeed: 0.72,
    strideSpeed: 0.24,
    clipTimeScale: 0.88,
    clipCrossFadeSeconds: 0.42,
    floorClearance: 0.022,
    floorResponse: 12,
    plantBias: 0.9,
  },
  walkStart: {
    energy: 0.58,
    attentiveness: 0.64,
    forwardLean: -0.032,
    sideSway: 0.024,
    verticalLift: 0.018,
    pulseSpeed: 1.5,
    strideSpeed: 0.78,
    clipTimeScale: 0.96,
    clipCrossFadeSeconds: 0.18,
    floorClearance: 0.024,
    floorResponse: 18,
    plantBias: 0.64,
  },
  walking: {
    energy: 0.68,
    attentiveness: 0.58,
    forwardLean: -0.038,
    sideSway: 0.03,
    verticalLift: 0.024,
    pulseSpeed: 1.9,
    strideSpeed: 1.05,
    clipTimeScale: 1,
    clipCrossFadeSeconds: 0.14,
    floorClearance: 0.028,
    floorResponse: 18,
    plantBias: 0.58,
  },
  walkStop: {
    energy: 0.42,
    attentiveness: 0.68,
    forwardLean: -0.018,
    sideSway: 0.018,
    verticalLift: 0.014,
    pulseSpeed: 1.25,
    strideSpeed: 0.55,
    clipTimeScale: 0.88,
    clipCrossFadeSeconds: 0.18,
    floorClearance: 0.02,
    floorResponse: 20,
    plantBias: 0.72,
  },
  turnLeft: {
    energy: 0.5,
    attentiveness: 0.76,
    forwardLean: -0.016,
    sideSway: 0.02,
    verticalLift: 0.016,
    pulseSpeed: 1.45,
    strideSpeed: 0.72,
    clipTimeScale: 0.94,
    clipCrossFadeSeconds: 0.18,
    floorClearance: 0.02,
    floorResponse: 20,
    plantBias: 0.78,
  },
  turnRight: {
    energy: 0.5,
    attentiveness: 0.76,
    forwardLean: -0.016,
    sideSway: -0.02,
    verticalLift: 0.016,
    pulseSpeed: 1.45,
    strideSpeed: 0.72,
    clipTimeScale: 0.94,
    clipCrossFadeSeconds: 0.18,
    floorClearance: 0.02,
    floorResponse: 20,
    plantBias: 0.78,
  },
  sitDown: {
    energy: 0.2,
    attentiveness: 0.62,
    forwardLean: -0.018,
    sideSway: 0.004,
    verticalLift: 0.002,
    pulseSpeed: 0.52,
    strideSpeed: 0.08,
    clipTimeScale: 0.82,
    clipCrossFadeSeconds: 0.16,
    floorClearance: 0.012,
    floorResponse: 24,
    plantBias: 0.98,
  },
  sitting: {
    energy: 0.16,
    attentiveness: 0.54,
    forwardLean: -0.012,
    sideSway: 0.006,
    verticalLift: 0.003,
    pulseSpeed: 0.58,
    strideSpeed: 0.12,
    clipTimeScale: 0.72,
    clipCrossFadeSeconds: 0.44,
    floorClearance: 0.018,
    floorResponse: 14,
    plantBias: 1,
  },
  standUp: {
    energy: 0.3,
    attentiveness: 0.72,
    forwardLean: -0.012,
    sideSway: 0.006,
    verticalLift: 0.004,
    pulseSpeed: 0.72,
    strideSpeed: 0.1,
    clipTimeScale: 0.9,
    clipCrossFadeSeconds: 0.18,
    floorClearance: 0.014,
    floorResponse: 24,
    plantBias: 0.96,
  },
};

function approach(current: number, target: number, response: number, delta: number) {
  if (delta <= 0) {
    return current;
  }
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-response * delta));
}

function approachVector(current: THREE.Vector3, target: THREE.Vector3, response: number, delta: number) {
  const amount = delta <= 0 ? 0 : 1 - Math.exp(-response * delta);
  current.lerp(target, amount);
}

function profileBlend(weights: Record<YukiMotionState, number>): MotionProfile {
  const blended: MotionProfile = {
    energy: 0,
    attentiveness: 0,
    forwardLean: 0,
    sideSway: 0,
    verticalLift: 0,
    pulseSpeed: 0,
    strideSpeed: 0,
    clipTimeScale: 0,
    clipCrossFadeSeconds: 0,
    floorClearance: 0,
    floorResponse: 0,
    plantBias: 0,
  };

  MOTION_STATES.forEach((state) => {
    const weight = weights[state];
    const profile = MOTION_PROFILES[state];
    blended.energy += profile.energy * weight;
    blended.attentiveness += profile.attentiveness * weight;
    blended.forwardLean += profile.forwardLean * weight;
    blended.sideSway += profile.sideSway * weight;
    blended.verticalLift += profile.verticalLift * weight;
    blended.pulseSpeed += profile.pulseSpeed * weight;
    blended.strideSpeed += profile.strideSpeed * weight;
    blended.clipTimeScale += profile.clipTimeScale * weight;
    blended.clipCrossFadeSeconds += profile.clipCrossFadeSeconds * weight;
    blended.floorClearance += profile.floorClearance * weight;
    blended.floorResponse += profile.floorResponse * weight;
    blended.plantBias += profile.plantBias * weight;
  });

  return blended;
}

function triangularContact(phase: number, center: number) {
  const wrapped = Math.abs(((phase - center + 1.5) % 1) - 0.5);
  return THREE.MathUtils.smoothstep(1 - wrapped * 2, 0.22, 0.72);
}

function actualXrSession(intent: YukiMotionIntent) {
  return intent.activeXrSession && !intent.emulatorXrSession;
}

export class YukiMotionEngine {
  private readonly weights: Record<YukiMotionState, number> = {
    idle: 1,
    listening: 0,
    thinking: 0,
    speaking: 0,
    alert: 0,
    ready: 0,
    walkStart: 0,
    walking: 0,
    walkStop: 0,
    turnLeft: 0,
    turnRight: 0,
    sitDown: 0,
    sitting: 0,
    standUp: 0,
  };

  private readonly rootOffset = new THREE.Vector3();
  private readonly rootOffsetTarget = new THREE.Vector3();
  private readonly rootRotation = new THREE.Euler(0, 0, 0, "YXZ");
  private stridePhase = 0;
  private lastState: YukiMotionState = "idle";
  private transitionPulse = 0;
  private clipTimeScale = MOTION_PROFILES.idle.clipTimeScale;
  private clipCrossFadeSeconds = MOTION_PROFILES.idle.clipCrossFadeSeconds;
  private floorClearance = MOTION_PROFILES.idle.floorClearance;
  private floorResponse = MOTION_PROFILES.idle.floorResponse;

  readonly frame: YukiMotionFrame = {
    rootOffset: this.rootOffset,
    rootRotation: this.rootRotation,
    clipTimeScale: this.clipTimeScale,
    clipCrossFadeSeconds: this.clipCrossFadeSeconds,
    floorClearance: this.floorClearance,
    floorResponse: this.floorResponse,
    leftFootLock: 1,
    rightFootLock: 1,
    stridePhase: this.stridePhase,
    stateWeights: this.weights,
  };

  reset(state: YukiMotionState = "idle") {
    MOTION_STATES.forEach((name) => {
      this.weights[name] = name === state ? 1 : 0;
    });
    this.rootOffset.set(0, 0, 0);
    this.rootOffsetTarget.set(0, 0, 0);
    this.rootRotation.set(0, 0, 0, "YXZ");
    this.stridePhase = 0;
    this.lastState = state;
    this.transitionPulse = 0;
    const profile = MOTION_PROFILES[state];
    this.clipTimeScale = profile.clipTimeScale;
    this.clipCrossFadeSeconds = profile.clipCrossFadeSeconds;
    this.floorClearance = profile.floorClearance;
    this.floorResponse = profile.floorResponse;
  }

  update(intent: YukiMotionIntent): YukiMotionFrame {
    const delta = THREE.MathUtils.clamp(intent.delta, 0, 1 / 20);
    if (intent.state !== this.lastState) {
      this.lastState = intent.state;
      this.transitionPulse = 1;
    }

    const targetResponse = intent.state === "alert" ? 18 : 9;
    MOTION_STATES.forEach((state) => {
      this.weights[state] = approach(this.weights[state], state === intent.state ? 1 : 0, targetResponse, delta);
    });

    const totalWeight = MOTION_STATES.reduce((sum, state) => sum + this.weights[state], 0) || 1;
    MOTION_STATES.forEach((state) => {
      this.weights[state] /= totalWeight;
    });

    const profile = profileBlend(this.weights);
    const isActualXr = actualXrSession(intent);
    const sittingWeight = THREE.MathUtils.clamp(
      this.weights.sitting + this.weights.sitDown + this.weights.standUp * 0.72,
      0,
      1,
    );
    const speechBoost = intent.speechSpeaking ? 0.12 : 0;
    const xrDamp = isActualXr ? 0.68 : 1;
    const plantedVerticalDamp = isActualXr ? THREE.MathUtils.lerp(0.12, 0.015, sittingWeight) : 1;
    const plantedHorizontalDamp = isActualXr ? THREE.MathUtils.lerp(0.46, 0.14, sittingWeight) : 1;
    const plantedRootTiltDamp = isActualXr ? THREE.MathUtils.lerp(0.58, 0.2, sittingWeight) : 1;
    const previewBoost = intent.desktopPreviewActive ? 1.1 : 1;
    const energy = THREE.MathUtils.clamp((profile.energy + speechBoost) * xrDamp * previewBoost, 0, 1);
    const pulse = intent.elapsed * profile.pulseSpeed;
    const sidePhase = Math.sin(pulse * 0.78);
    const liftPhase = Math.max(0, Math.sin(pulse));

    this.transitionPulse = approach(this.transitionPulse, 0, 5.5, delta);
    const strideDamp = isActualXr
      ? THREE.MathUtils.lerp(0.28, 0.02, THREE.MathUtils.clamp(profile.plantBias, 0, 1))
      : 1;
    this.stridePhase =
      (this.stridePhase + delta * profile.strideSpeed * (0.45 + energy) * (1 - sittingWeight) * strideDamp) % 1;

    this.rootOffsetTarget.set(
      sidePhase * profile.sideSway * energy * plantedHorizontalDamp,
      (profile.verticalLift * (0.35 + liftPhase * 0.65) + (isActualXr ? 0 : this.transitionPulse * 0.01)) *
        plantedVerticalDamp,
      -profile.attentiveness * 0.012 * energy * plantedHorizontalDamp,
    );
    approachVector(this.rootOffset, this.rootOffsetTarget, 8.5, delta);

    const shoulderCounter = Math.sin(pulse * 0.62) * energy;
    this.rootRotation.x = approach(
      this.rootRotation.x,
      profile.forwardLean * (0.8 + energy * 0.2) * plantedRootTiltDamp,
      8,
      delta,
    );
    this.rootRotation.y = approach(this.rootRotation.y, shoulderCounter * 0.018 + this.transitionPulse * 0.018, 7, delta);
    this.rootRotation.z = approach(this.rootRotation.z, -sidePhase * 0.026 * energy * plantedRootTiltDamp, 7, delta);

    const targetClipTimeScale = (profile.clipTimeScale + speechBoost * 0.18) * (isActualXr ? 0.94 - sittingWeight * 0.12 : 1);
    const targetFloorClearance = isActualXr
      ? THREE.MathUtils.lerp(0.008, 0.0045, sittingWeight) + Math.max(0, 1 - profile.plantBias) * 0.003
      : profile.floorClearance;
    const targetFloorResponse = isActualXr
      ? THREE.MathUtils.lerp(22, 26, sittingWeight) + Math.max(0, 1 - profile.plantBias) * 2
      : profile.floorResponse;

    this.clipTimeScale = approach(this.clipTimeScale, targetClipTimeScale, 8, delta);
    this.clipCrossFadeSeconds = approach(this.clipCrossFadeSeconds, profile.clipCrossFadeSeconds, 7, delta);
    this.floorClearance = approach(this.floorClearance, targetFloorClearance, 11, delta);
    this.floorResponse = approach(this.floorResponse, targetFloorResponse, 11, delta);

    this.frame.clipTimeScale = THREE.MathUtils.clamp(this.clipTimeScale, isActualXr ? 0.58 : 0.72, 1.24);
    this.frame.clipCrossFadeSeconds = THREE.MathUtils.clamp(this.clipCrossFadeSeconds, 0.12, 0.48);
    this.frame.floorClearance = THREE.MathUtils.clamp(this.floorClearance, isActualXr ? 0.004 : 0.014, 0.04);
    this.frame.floorResponse = THREE.MathUtils.clamp(this.floorResponse, 8, isActualXr ? 28 : 18);
    const leftContact = triangularContact(this.stridePhase, 0.08);
    const rightContact = triangularContact(this.stridePhase, 0.58);
    const bilateralPlant = isActualXr
      ? THREE.MathUtils.clamp(0.62 + profile.plantBias * 0.34 + sittingWeight * 0.18 - energy * 0.08, 0.72, 1)
      : 0;
    this.frame.leftFootLock = THREE.MathUtils.lerp(leftContact, 1, bilateralPlant);
    this.frame.rightFootLock = THREE.MathUtils.lerp(rightContact, 1, bilateralPlant);
    this.frame.stridePhase = this.stridePhase;

    return this.frame;
  }
}

export function createYukiMotionEngine() {
  return new YukiMotionEngine();
}
