import type { SpatialAffordance, SpatialAffordanceKind, SpatialAffordanceStore } from "./spatialAffordances";
import type { YukiMotionState } from "./yukiMotionEngine";

export const YUKI_AUTONOMOUS_SEAT_STABILITY = 0.76;
export const YUKI_AUTONOMOUS_TABLE_STABILITY = 0.68;
export const YUKI_AUTONOMOUS_SEAT_COOLDOWN_SECONDS = 3.5;

export type YukiBehaviorMode = "none" | "attention" | "manual" | "sitting" | "table" | "standing";
export type YukiBehaviorPriority =
  | "attention"
  | "manual-placement"
  | "autonomous-seat"
  | "table-affordance"
  | "standing-idle";

export type YukiPlannerPlacementSnapshot = {
  hasUserPlacement: boolean;
  source: "manual" | "autonomous" | null;
  affordanceKind: SpatialAffordanceKind | null;
  affordanceId: string | null;
};

export type YukiBehaviorPlannerState = {
  mode: YukiBehaviorMode;
  priority: YukiBehaviorPriority;
  activeAffordanceId: string | null;
  activeAffordanceKind: SpatialAffordanceKind | null;
  lastAutonomousMoveAt: number;
  message: string;
};

export type YukiBehaviorPlannerOptions = {
  autonomousSeatCooldownSeconds?: number;
  seatStability?: number;
  tableStability?: number;
};

export type YukiBehaviorPlacementAction = {
  type: "place-at-affordance";
  source: "autonomous";
  affordance: SpatialAffordance;
};

export type YukiBehaviorPlan = {
  animationState: YukiMotionState;
  mode: YukiBehaviorMode;
  priority: YukiBehaviorPriority;
  activeAffordance: SpatialAffordance | null;
  activeAffordanceId: string | null;
  activeAffordanceKind: SpatialAffordanceKind | null;
  message: string;
  action: YukiBehaviorPlacementAction | null;
  state: YukiBehaviorPlannerState;
};

type CommitOptions = {
  animationState: YukiMotionState;
  mode: YukiBehaviorMode;
  priority: YukiBehaviorPriority;
  message: string;
  activeAffordance?: SpatialAffordance | null;
  activeAffordanceId?: string | null;
  activeAffordanceKind?: SpatialAffordanceKind | null;
  action?: YukiBehaviorPlacementAction | null;
};

export function createYukiBehaviorPlannerState(): YukiBehaviorPlannerState {
  return {
    mode: "none",
    priority: "standing-idle",
    activeAffordanceId: null,
    activeAffordanceKind: null,
    lastAutonomousMoveAt: Number.NEGATIVE_INFINITY,
    message: "Spatial affordances are warming up.",
  };
}

export function planYukiBehavior({
  baseAnimationState,
  elapsed,
  placement,
  spatialAffordances,
  state,
  options = {},
}: {
  baseAnimationState: YukiMotionState;
  elapsed: number;
  placement: YukiPlannerPlacementSnapshot;
  spatialAffordances: SpatialAffordanceStore;
  state: YukiBehaviorPlannerState;
  options?: YukiBehaviorPlannerOptions;
}): YukiBehaviorPlan {
  const seatStability = options.seatStability ?? YUKI_AUTONOMOUS_SEAT_STABILITY;
  const tableStability = options.tableStability ?? YUKI_AUTONOMOUS_TABLE_STABILITY;
  const seatCooldown = options.autonomousSeatCooldownSeconds ?? YUKI_AUTONOMOUS_SEAT_COOLDOWN_SECONDS;

  const hasManualPlacement = placement.hasUserPlacement && placement.source !== "autonomous";
  if (hasManualPlacement) {
    if (placement.affordanceKind === "seat") {
      return commit(state, {
        animationState: "sitting",
        mode: "sitting",
        priority: "manual-placement",
        activeAffordanceId: placement.affordanceId,
        activeAffordanceKind: "seat",
        message: "Yuki is using the placed low surface as a seat.",
      });
    }

    return commit(state, {
      animationState: baseAnimationState,
      mode: "manual",
      priority: "manual-placement",
      activeAffordanceId: placement.affordanceId,
      activeAffordanceKind: placement.affordanceKind,
      message: manualPlacementMessage(placement.affordanceKind),
    });
  }

  if (
    placement.hasUserPlacement &&
    placement.source === "autonomous" &&
    placement.affordanceKind === "seat"
  ) {
    return commit(state, {
      animationState: "sitting",
      mode: "sitting",
      priority: "autonomous-seat",
      activeAffordanceId: placement.affordanceId,
      activeAffordanceKind: "seat",
      message: "Yuki is using a stable scanned low surface as a seat.",
    });
  }

  if (isAttentionState(baseAnimationState)) {
    return commit(state, {
      animationState: baseAnimationState,
      mode: "attention",
      priority: "attention",
      message: attentionMessage(baseAnimationState),
    });
  }

  const seat = canUseAutonomousSeatPose(baseAnimationState)
    ? spatialAffordances.best("seat", seatStability)
    : null;
  const canMoveToSeat = seat && elapsed - state.lastAutonomousMoveAt > seatCooldown;
  if (seat && canMoveToSeat) {
    state.lastAutonomousMoveAt = elapsed;
    return commit(state, {
      animationState: "sitting",
      mode: "sitting",
      priority: "autonomous-seat",
      activeAffordance: seat,
      activeAffordanceId: seat.id,
      activeAffordanceKind: "seat",
      action: {
        type: "place-at-affordance",
        source: "autonomous",
        affordance: seat,
      },
      message: `Yuki chose a stable ${seat.label ?? "low surface"} to sit.`,
    });
  }

  const table = canUseTableIdle(baseAnimationState) ? spatialAffordances.best("table", tableStability) : null;
  if (table) {
    return commit(state, {
      animationState: baseAnimationState,
      mode: "table",
      priority: "table-affordance",
      activeAffordance: table,
      activeAffordanceId: table.id,
      activeAffordanceKind: "table",
      message: `Yuki is standing and tracking the stable ${table.label ?? "table"} surface.`,
    });
  }

  return commit(state, {
    animationState: baseAnimationState,
    mode: "standing",
    priority: "standing-idle",
    message: "Yuki is standing idle while spatial affordances settle.",
  });
}

function isAttentionState(state: YukiMotionState) {
  return state === "alert" || state === "listening" || state === "speaking";
}

function canUseAutonomousSeatPose(state: YukiMotionState) {
  return state === "idle" || state === "ready" || state === "thinking";
}

function canUseTableIdle(state: YukiMotionState) {
  return state === "idle" || state === "ready" || state === "thinking";
}

function attentionMessage(state: YukiMotionState) {
  if (state === "alert") {
    return "Yuki is prioritizing an alert and staying standing.";
  }
  if (state === "speaking") {
    return "Yuki is prioritizing the conversation before autonomous movement.";
  }
  return "Yuki is listening and holding close to the user.";
}

function manualPlacementMessage(kind: SpatialAffordanceKind | null) {
  if (kind === "table") {
    return "Manual placement is active on a table-height surface.";
  }
  if (kind === "floor") {
    return "Manual placement is active on the floor.";
  }
  if (kind === "blocked") {
    return "Manual placement is active near a blocked surface.";
  }
  return "Manual placement is active.";
}

function commit(state: YukiBehaviorPlannerState, options: CommitOptions): YukiBehaviorPlan {
  const activeAffordance = options.activeAffordance ?? null;
  const activeAffordanceId = options.activeAffordanceId ?? activeAffordance?.id ?? null;
  const activeAffordanceKind = options.activeAffordanceKind ?? activeAffordance?.kind ?? null;

  state.mode = options.mode;
  state.priority = options.priority;
  state.activeAffordanceId = activeAffordanceId;
  state.activeAffordanceKind = activeAffordanceKind;
  state.message = options.message;

  return {
    animationState: options.animationState,
    mode: options.mode,
    priority: options.priority,
    activeAffordance,
    activeAffordanceId,
    activeAffordanceKind,
    message: options.message,
    action: options.action ?? null,
    state,
  };
}
