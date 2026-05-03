import * as THREE from "three";

export type SpatialAffordanceKind = "floor" | "seat" | "table" | "blocked";
export type SpatialSurfaceSource = "xr-plane" | "manual" | "stage" | "synthetic" | "object-box";

export type SpatialSurfaceObservation = {
  id?: string;
  center: THREE.Vector3;
  normal?: THREE.Vector3;
  width: number;
  depth: number;
  source: SpatialSurfaceSource;
  timestamp: number;
  confidence?: number;
  label?: string;
};

export type SpatialObjectObservation = {
  id?: string;
  className: string;
  center: THREE.Vector3;
  size: THREE.Vector3;
  yaw?: number;
  timestamp: number;
  confidence?: number;
  source?: SpatialSurfaceSource;
};

export type SpatialAffordance = {
  id: string;
  kind: SpatialAffordanceKind;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  size: THREE.Vector3;
  confidence: number;
  stability: number;
  firstSeen: number;
  lastSeen: number;
  source: SpatialSurfaceSource;
  label?: string;
};

type MutableAffordance = SpatialAffordance;

const HORIZONTAL_NORMAL_Y = 0.78;
const FLOOR_MAX_HEIGHT = 0.12;
const SEAT_MIN_HEIGHT = 0.28;
const SEAT_MAX_HEIGHT = 0.68;
const TABLE_MIN_HEIGHT = 0.62;
const TABLE_MAX_HEIGHT = 1.18;
const MIN_USABLE_AREA = 0.14;
const MIN_SEAT_WIDTH = 0.34;
const STALE_SECONDS = 8;

function quantize(value: number, step = 0.18) {
  return Math.round(value / step) * step;
}

function observationId(observation: SpatialSurfaceObservation, floorY: number) {
  if (observation.id) {
    return observation.id;
  }
  const height = observation.center.y - floorY;
  return [
    observation.source,
    quantize(observation.center.x).toFixed(2),
    quantize(height).toFixed(2),
    quantize(observation.center.z).toFixed(2),
    quantize(observation.width).toFixed(2),
    quantize(observation.depth).toFixed(2),
  ].join(":");
}

function classifySurface(observation: SpatialSurfaceObservation, floorY: number): SpatialAffordanceKind {
  const normal = observation.normal ?? new THREE.Vector3(0, 1, 0);
  const normalY = Math.abs(normal.y);
  const height = observation.center.y - floorY;
  const area = observation.width * observation.depth;
  const shortestEdge = Math.min(observation.width, observation.depth);

  if (normalY < HORIZONTAL_NORMAL_Y || area < MIN_USABLE_AREA) {
    return "blocked";
  }
  if (height <= FLOOR_MAX_HEIGHT) {
    return "floor";
  }
  if (height >= SEAT_MIN_HEIGHT && height <= SEAT_MAX_HEIGHT && shortestEdge >= MIN_SEAT_WIDTH) {
    return "seat";
  }
  if (height >= TABLE_MIN_HEIGHT && height <= TABLE_MAX_HEIGHT) {
    return "table";
  }
  return "blocked";
}

function classifyObjectBox(observation: SpatialObjectObservation): SpatialAffordanceKind {
  const name = observation.className.toLowerCase();
  if (/(chair|couch|sofa|bench|stool|ottoman)/.test(name)) {
    return "seat";
  }
  if (/(table|desk|counter|island|shelf)/.test(name)) {
    return "table";
  }
  if (/(floor|rug|mat)/.test(name)) {
    return "floor";
  }
  return "blocked";
}

function scoreAffordance(candidate: SpatialAffordance) {
  const kindBias =
    candidate.kind === "seat" ? 1.15 :
      candidate.kind === "floor" ? 0.9 :
        candidate.kind === "table" ? 0.8 :
          0.35;
  const area = Math.max(0.01, candidate.size.x * candidate.size.z);
  return candidate.stability * candidate.confidence * kindBias + Math.min(area, 1.2) * 0.08;
}

export class SpatialAffordanceStore {
  private readonly items = new Map<string, MutableAffordance>();
  private readonly scratchNormal = new THREE.Vector3();

  observeSurface(observation: SpatialSurfaceObservation, floorY = 0) {
    const id = observationId(observation, floorY);
    const kind = classifySurface(observation, floorY);
    const confidence = THREE.MathUtils.clamp(observation.confidence ?? 0.72, 0, 1);
    const normal = this.scratchNormal.copy(observation.normal ?? new THREE.Vector3(0, 1, 0));
    if (normal.lengthSq() < 0.0001) {
      normal.set(0, 1, 0);
    }
    normal.normalize();
    if (normal.y < 0) {
      normal.multiplyScalar(-1);
    }

    const existing = this.items.get(id);
    if (existing) {
      existing.kind = kind;
      existing.center.lerp(observation.center, 0.36);
      existing.normal.lerp(normal, 0.34).normalize();
      existing.size.set(
        THREE.MathUtils.lerp(existing.size.x, observation.width, 0.36),
        THREE.MathUtils.lerp(existing.size.y, Math.max(0.02, observation.center.y - floorY), 0.36),
        THREE.MathUtils.lerp(existing.size.z, observation.depth, 0.36),
      );
      existing.confidence = THREE.MathUtils.lerp(existing.confidence, confidence, 0.3);
      existing.stability = THREE.MathUtils.clamp(existing.stability + 0.16 * confidence, 0, 1);
      existing.lastSeen = observation.timestamp;
      existing.source = observation.source;
      existing.label = observation.label ?? existing.label;
      return existing;
    }

    const candidate: MutableAffordance = {
      id,
      kind,
      center: observation.center.clone(),
      normal: normal.clone(),
      size: new THREE.Vector3(observation.width, Math.max(0.02, observation.center.y - floorY), observation.depth),
      confidence,
      stability: THREE.MathUtils.clamp(0.28 + confidence * 0.18, 0, 1),
      firstSeen: observation.timestamp,
      lastSeen: observation.timestamp,
      source: observation.source,
      label: observation.label,
    };
    this.items.set(id, candidate);
    return candidate;
  }

  observeObjectBox(observation: SpatialObjectObservation, floorY = 0) {
    const kind = classifyObjectBox(observation);
    const bottomY = observation.center.y - observation.size.y * 0.5;
    const surfaceY =
      kind === "seat"
        ? bottomY + THREE.MathUtils.clamp(observation.size.y * 0.45, 0.34, 0.55)
        : kind === "table"
          ? bottomY + observation.size.y
          : observation.center.y;
    const surfaceCenter = observation.center.clone().setY(surfaceY);
    return this.observeSurface(
      {
        id:
          observation.id ??
          `object:${observation.className}:${quantize(observation.center.x).toFixed(2)}:${quantize(observation.center.z).toFixed(2)}`,
        center: surfaceCenter,
        normal: new THREE.Vector3(0, 1, 0),
        width: Math.max(0.08, observation.size.x),
        depth: Math.max(0.08, observation.size.z),
        source: observation.source ?? "object-box",
        timestamp: observation.timestamp,
        confidence: observation.confidence ?? 0.68,
        label: observation.className,
      },
      floorY,
    );
  }

  update(now: number) {
    this.items.forEach((candidate, id) => {
      const age = Math.max(0, now - candidate.lastSeen);
      if (candidate.source === "manual" || candidate.source === "stage") {
        candidate.stability = Math.max(candidate.stability, 0.82);
        return;
      }
      if (age > 1) {
        candidate.stability = THREE.MathUtils.clamp(candidate.stability - age * 0.012, 0, 1);
      }
      if (age > STALE_SECONDS) {
        this.items.delete(id);
      }
    });
  }

  seedFloor(center: THREE.Vector3, width: number, depth: number, timestamp: number, source: SpatialSurfaceSource = "stage") {
    return this.observeSurface(
      {
        id: `${source}:floor:${quantize(center.x).toFixed(2)}:${quantize(center.z).toFixed(2)}`,
        center,
        normal: new THREE.Vector3(0, 1, 0),
        width,
        depth,
        source,
        timestamp,
        confidence: 0.92,
        label: "floor",
      },
      0,
    );
  }

  list(kind?: SpatialAffordanceKind): SpatialAffordance[] {
    const values = Array.from(this.items.values()).filter((candidate) => !kind || candidate.kind === kind);
    return values.sort((a, b) => scoreAffordance(b) - scoreAffordance(a));
  }

  best(kind: SpatialAffordanceKind, minStability = 0.68): SpatialAffordance | null {
    return this.list(kind).find((candidate) => candidate.stability >= minStability && candidate.confidence >= 0.45) ?? null;
  }

  nearestRayHit(origin: THREE.Vector3, direction: THREE.Vector3, kind?: SpatialAffordanceKind): SpatialAffordance | null {
    const rayDirection = direction.clone();
    if (rayDirection.lengthSq() < 0.0001) {
      return null;
    }
    rayDirection.normalize();

    let best: SpatialAffordance | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of this.list(kind)) {
      if (candidate.kind === "blocked") {
        continue;
      }
      const toCandidate = candidate.center.clone().sub(origin);
      const alongRay = toCandidate.dot(rayDirection);
      if (alongRay < 0.2 || alongRay > 3.6) {
        continue;
      }
      const closestPoint = origin.clone().addScaledVector(rayDirection, alongRay);
      const radialDistance = closestPoint.distanceTo(candidate.center);
      const radius = Math.max(0.26, Math.min(candidate.size.x, candidate.size.z) * 0.55);
      if (radialDistance <= radius && alongRay < bestDistance) {
        best = candidate;
        bestDistance = alongRay;
      }
    }
    return best;
  }
}

export function createSpatialAffordanceStore() {
  return new SpatialAffordanceStore();
}
