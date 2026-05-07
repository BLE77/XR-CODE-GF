export type WireValue =
  | string
  | number
  | boolean
  | null
  | WireValue[]
  | { [key: string]: WireValue };

export interface AgentWireEvent {
  type: string;
  ts: string;
  session_id?: string | null;
  payload: Record<string, WireValue>;
}

export type CodingSessionStatus = "starting" | "running" | "closing" | "finished" | "failed";

export interface CodingSessionSnapshot {
  sessionId: string;
  intent?: string;
  title: string;
  toolLabel?: string | null;
  repoPath?: string;
  command?: string;
  status: CodingSessionStatus;
  phase?: string | null;
  pid?: number;
  exitCode?: number | null;
  summary?: string | null;
  logPath?: string | null;
  workerLabel?: string | null;
  taskTitle?: string | null;
  workerPhase?: string | null;
  statusText?: string | null;
  managerSummary?: string | null;
  waitingOnUser: boolean;
  needsReview: boolean;
  blockedReason?: string | null;
  pendingQuestion?: string | null;
  lastUpdate?: string | null;
  outputSummary?: string | null;
  outputLineCount?: number | null;
  outputTail: string[];
  hasScreen?: boolean;
  screenText?: string | null;
  screenRows?: number | null;
  screenColumns?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  snapshotAt?: string | null;
}

export interface ConnectionSettings {
  url?: string;
  scheme?: "ws" | "wss";
  host: string;
  port: number;
}

export function eventId(event: AgentWireEvent): string {
  return `${event.ts}-${event.type}-${event.session_id ?? "none"}`;
}

export function payloadText(payload: Record<string, WireValue>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function payloadBool(payload: Record<string, WireValue>, key: string): boolean | undefined {
  const value = payload[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

export function payloadInt(payload: Record<string, WireValue>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function formatEventTime(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) {
    return ts;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

export function summarizeSignal(event: AgentWireEvent): string {
  const text =
    payloadText(event.payload, "text") ??
    payloadText(event.payload, "summary") ??
    payloadText(event.payload, "manager_summary") ??
    payloadText(event.payload, "status_text") ??
    payloadText(event.payload, "question") ??
    payloadText(event.payload, "pending_question");
  if (text) {
    return text;
  }
  if (event.type === "worker.updated") {
    const workerLabel = payloadText(event.payload, "worker_label") ?? "Worker";
    const workerPhase = payloadText(event.payload, "worker_phase") ?? "updated";
    return `${workerLabel} ${workerPhase.replaceAll("_", " ")}.`;
  }
  return event.type.replaceAll(".", " ");
}

export function signalLabel(event: AgentWireEvent): string {
  switch (event.type) {
    case "assistant.reply":
    case "hermes.status":
    case "agent.summary":
      return "Hermes";
    case "worker.pending_question":
    case "worker.updated":
      return payloadText(event.payload, "worker_label") ?? "Worker";
    case "terminal.finished":
    case "terminal.failed":
      return payloadText(event.payload, "worker_label") ?? "Session";
    default:
      return "Signal";
  }
}

export function isHighSignalEvent(event: AgentWireEvent): boolean {
  switch (event.type) {
    case "assistant.reply":
    case "hermes.status":
    case "agent.summary":
    case "worker.pending_question":
    case "terminal.finished":
    case "terminal.failed":
    case "terminal.started":
    case "session.started":
    case "session.finished":
    case "session.failed":
    case "project.selected":
      return true;
    case "worker.updated": {
      const phase = payloadText(event.payload, "worker_phase") ?? "";
      return (
        ["opening", "working", "waiting_on_user", "blocked", "done", "needs_review"].includes(phase) ||
        payloadBool(event.payload, "waiting_on_user") === true ||
        payloadBool(event.payload, "needs_review") === true
      );
    }
    default:
      return false;
  }
}
