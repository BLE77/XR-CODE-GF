import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = process.cwd();

function loadTsModule(relativePath) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "three") {
      return require("three");
    }
    return require(specifier);
  };
  new Function("require", "module", "exports", output)(localRequire, module, module.exports);
  return module.exports;
}

const THREE = require("three");
const {
  createSpatialAffordanceStore,
} = loadTsModule("src/lib/spatialAffordances.ts");
const {
  createYukiBehaviorPlannerState,
  planYukiBehavior,
} = loadTsModule("src/lib/yukiBehaviorPlanner.ts");
const {
  createYukiMotionEngine,
} = loadTsModule("src/lib/yukiMotionEngine.ts");

function observeSurface(store, y, width = 0.7, depth = 0.7) {
  return store.observeSurface(
    {
      center: new THREE.Vector3(0, y, -1),
      normal: new THREE.Vector3(0, 1, 0),
      width,
      depth,
      source: "synthetic",
      timestamp: 1,
      confidence: 0.92,
      label: `surface-${y}`,
    },
    0,
  );
}

function sampleMotion({
  state,
  resetState = state,
  seconds = 4,
  settleSeconds = 1.5,
  speechSpeaking = false,
  activeXrSession = true,
  desktopPreviewActive = false,
  emulatorXrSession = false,
}) {
  const engine = createYukiMotionEngine();
  engine.reset(resetState);
  const samples = [];
  const step = 1 / 60;
  for (let elapsed = step; elapsed <= seconds + 0.0001; elapsed += step) {
    const frame = engine.update({
      state,
      delta: step,
      elapsed,
      speechSpeaking,
      activeXrSession,
      desktopPreviewActive,
      emulatorXrSession,
    });
    if (elapsed >= settleSeconds) {
      samples.push({
        rootY: frame.rootOffset.y,
        rootPitch: frame.rootRotation.x,
        rootRoll: frame.rootRotation.z,
        floorClearance: frame.floorClearance,
        floorResponse: frame.floorResponse,
        leftFootLock: frame.leftFootLock,
        rightFootLock: frame.rightFootLock,
        stridePhase: frame.stridePhase,
        clipTimeScale: frame.clipTimeScale,
      });
    }
  }
  return samples;
}

function maxAbs(samples, key) {
  return Math.max(...samples.map((sample) => Math.abs(sample[key])));
}

function minValue(samples, key) {
  return Math.min(...samples.map((sample) => sample[key]));
}

function maxValue(samples, key) {
  return Math.max(...samples.map((sample) => sample[key]));
}

function strideTravel(samples) {
  return samples.reduce((sum, sample, index) => {
    if (index === 0) {
      return 0;
    }
    const previous = samples[index - 1].stridePhase;
    return sum + Math.abs(sample.stridePhase - previous);
  }, 0);
}

{
  const store = createSpatialAffordanceStore();
  assert.equal(observeSurface(store, 0.08).kind, "floor");
  assert.equal(observeSurface(store, 0.42).kind, "seat");
  assert.equal(observeSurface(store, 0.82).kind, "table");
  assert.equal(observeSurface(store, 0.42, 0.2, 0.2).kind, "blocked");
  assert.equal(
    store.observeObjectBox({
      className: "chair",
      center: new THREE.Vector3(0.2, 0.44, -1),
      size: new THREE.Vector3(0.7, 0.88, 0.7),
      timestamp: 2,
      confidence: 0.9,
    }).kind,
    "seat",
  );
  assert.equal(
    store.observeObjectBox({
      className: "desk",
      center: new THREE.Vector3(-0.4, 0.55, -1.2),
      size: new THREE.Vector3(1.2, 0.74, 0.62),
      timestamp: 2,
      confidence: 0.9,
    }).kind,
    "table",
  );
}

{
  const store = createSpatialAffordanceStore();
  const state = createYukiBehaviorPlannerState();
  const plan = planYukiBehavior({
    baseAnimationState: "idle",
    elapsed: 10,
    placement: {
      hasUserPlacement: true,
      source: "manual",
      affordanceKind: "seat",
      affordanceId: "manual-seat",
    },
    spatialAffordances: store,
    state,
  });
  assert.equal(plan.animationState, "sitting");
  assert.equal(plan.priority, "manual-placement");
}

{
  const store = createSpatialAffordanceStore();
  const seat = observeSurface(store, 0.42);
  seat.stability = 1;
  const state = createYukiBehaviorPlannerState();
  const plan = planYukiBehavior({
    baseAnimationState: "idle",
    elapsed: 10,
    placement: {
      hasUserPlacement: false,
      source: null,
      affordanceKind: null,
      affordanceId: null,
    },
    spatialAffordances: store,
    state,
    options: { autonomousSeatCooldownSeconds: 0 },
  });
  assert.equal(plan.animationState, "sitting");
  assert.equal(plan.action?.type, "place-at-affordance");
}

{
  const store = createSpatialAffordanceStore();
  const seat = observeSurface(store, 0.42);
  seat.stability = 1;
  const state = createYukiBehaviorPlannerState();
  const plan = planYukiBehavior({
    baseAnimationState: "listening",
    elapsed: 10,
    placement: {
      hasUserPlacement: false,
      source: null,
      affordanceKind: null,
      affordanceId: null,
    },
    spatialAffordances: store,
    state,
  });
  assert.equal(plan.priority, "attention");
  assert.equal(plan.action, null);
}

{
  const seated = sampleMotion({ state: "sitting", resetState: "sitting" });
  assert.ok(maxAbs(seated, "rootY") <= 0.002, "actual XR seated motion should not bob the root vertically");
  assert.ok(maxAbs(seated, "rootRoll") <= 0.002, "actual XR seated motion should not roll the planted root");
  assert.ok(maxValue(seated, "floorClearance") <= 0.006, "actual XR seated floor clearance should keep feet planted");
  assert.ok(minValue(seated, "floorResponse") >= 25, "actual XR seated grounding should settle quickly");
  assert.ok(minValue(seated, "leftFootLock") >= 0.99, "actual XR seated left foot should stay locked");
  assert.ok(minValue(seated, "rightFootLock") >= 0.99, "actual XR seated right foot should stay locked");
  assert.ok(strideTravel(seated) <= 0.002, "actual XR seated stride phase should not keep walking in place");
  assert.ok(maxValue(seated, "clipTimeScale") <= 0.68, "actual XR seated idle BVH should be slowed under the procedural pose");
}

{
  const idle = sampleMotion({ state: "idle", resetState: "idle" });
  assert.ok(maxAbs(idle, "rootY") <= 0.003, "actual XR idle root bob should stay below visible foot float");
  assert.ok(maxAbs(idle, "rootRoll") <= 0.004, "actual XR idle root roll should stay below visible foot tilt");
  assert.ok(maxValue(idle, "floorClearance") <= 0.0095, "actual XR idle floor clearance should stay near the floor");
  assert.ok(minValue(idle, "leftFootLock") >= 0.88, "actual XR idle left foot should remain mostly planted");
  assert.ok(minValue(idle, "rightFootLock") >= 0.88, "actual XR idle right foot should remain mostly planted");
}

{
  const speaking = sampleMotion({ state: "speaking", resetState: "speaking", speechSpeaking: true });
  assert.ok(maxAbs(speaking, "rootY") <= 0.006, "actual XR speaking motion should gesture without vertical foot float");
  assert.ok(maxAbs(speaking, "rootRoll") <= 0.01, "actual XR speaking root roll should not pry a planted foot upward");
  assert.ok(maxValue(speaking, "floorClearance") <= 0.011, "actual XR speaking floor clearance should stay grounded");
  assert.ok(minValue(speaking, "leftFootLock") >= 0.78, "actual XR speaking left foot should not fully unlock");
  assert.ok(minValue(speaking, "rightFootLock") >= 0.78, "actual XR speaking right foot should not fully unlock");
}

{
  const sitTransition = sampleMotion({
    state: "sitting",
    resetState: "idle",
    seconds: 3,
    settleSeconds: 0,
  });
  assert.ok(maxAbs(sitTransition, "rootY") <= 0.003, "actual XR transition into sitting should not hop off the floor");
  assert.ok(minValue(sitTransition, "leftFootLock") >= 0.88, "actual XR sitting transition should keep left foot planted");
  assert.ok(minValue(sitTransition, "rightFootLock") >= 0.88, "actual XR sitting transition should keep right foot planted");
}

console.log("Yuki scene-affordance checks passed.");
