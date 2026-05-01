import { useEffect, useRef, useState } from "react";
import {
  type AgentWireEvent,
  type CodingSessionSnapshot,
  type CodingSessionStatus,
  type ConnectionSettings,
  eventId,
  isHighSignalEvent,
  payloadBool,
  payloadInt,
  payloadText,
} from "./protocol";

interface CodingSessionState extends CodingSessionSnapshot {
  lastEventTs?: string;
}

interface PhaseState {
  title: string;
  tone: "calm" | "working" | "attention" | "success";
  subtitle: string;
}

interface AvatarState {
  mode: "idle" | "listening" | "thinking" | "speaking";
  transcript?: string;
  spokenText?: string;
}

interface HeadsetPromptState {
  title: string;
  detail: string;
  tone: "calm" | "working" | "attention" | "success";
  sessionId?: string;
}

interface ConnectionState {
  mode: "idle" | "connecting" | "connected" | "error";
  targetUrl?: string;
  lastConnectedUrl?: string;
  lastError?: string;
  hasReceivedEvents: boolean;
  lastEventTs?: string;
}

type CodingWorkerTool = "claude" | "codex" | "hermes";

type OpenCodingSessionOptions = {
  dangerouslySkipPermissions?: boolean;
};

function intentForWorkerTool(tool: CodingWorkerTool): string {
  switch (tool) {
    case "claude":
      return "open_claude_code";
    case "codex":
      return "open_codex";
    case "hermes":
      return "open_hermes_cli";
  }
}

function estimateSpeechDurationMs(text: string | undefined, explicitDurationMs?: number): number {
  if (explicitDurationMs && Number.isFinite(explicitDurationMs)) {
    return Math.max(800, explicitDurationMs);
  }
  if (!text) {
    return 2200;
  }
  return Math.max(2200, Math.min(9000, text.trim().length * 58));
}

function connectionFailureCopy(targetUrl: string): string {
  if (targetUrl.includes("/xr-agent-events")) {
    return `Could not open ${targetUrl}. Start the Mac companion so Vite can proxy to ws://127.0.0.1:8765, or switch to Direct socket and enter your Mac host.`;
  }
  return `Could not open ${targetUrl}.`;
}

function nextStatusForEvent(eventType: string, current: CodingSessionStatus): CodingSessionStatus {
  switch (eventType) {
    case "terminal.finished":
    case "session.finished":
      return "finished";
    case "terminal.failed":
    case "session.failed":
      return "failed";
    default:
      return current;
  }
}

function applyWorkerPayload(
  event: AgentWireEvent,
  state: CodingSessionState,
): CodingSessionState {
  const pendingQuestion = payloadText(event.payload, "pending_question");
  const waitingOnUser = payloadBool(event.payload, "waiting_on_user");
  const blockedReason = payloadText(event.payload, "blocked_reason");
  return {
    ...state,
    intent: payloadText(event.payload, "intent") ?? state.intent,
    workerLabel: payloadText(event.payload, "worker_label") ?? state.workerLabel,
    taskTitle: payloadText(event.payload, "task_title") ?? state.taskTitle,
    workerPhase: payloadText(event.payload, "worker_phase") ?? state.workerPhase,
    statusText: payloadText(event.payload, "status_text") ?? state.statusText,
    managerSummary: payloadText(event.payload, "manager_summary") ?? state.managerSummary,
    waitingOnUser: waitingOnUser ?? state.waitingOnUser,
    needsReview: payloadBool(event.payload, "needs_review") ?? state.needsReview,
    blockedReason:
      blockedReason === undefined ? state.blockedReason : blockedReason || undefined,
    pendingQuestion:
      pendingQuestion !== undefined
        ? pendingQuestion || undefined
        : waitingOnUser === false
          ? undefined
          : state.pendingQuestion,
    lastUpdate: payloadText(event.payload, "last_update") ?? state.lastUpdate,
  };
}

function baseSessionState(sessionId: string): CodingSessionState {
  return {
    sessionId,
    title: "Worker session",
    status: "running",
    waitingOnUser: false,
    needsReview: false,
    outputTail: [],
  };
}

function sortSessions(sessions: CodingSessionState[]): CodingSessionSnapshot[] {
  const rank = (session: CodingSessionState): number => {
    if (session.waitingOnUser) {
      return 0;
    }
    if (session.needsReview || session.workerPhase === "blocked" || session.blockedReason) {
      return 1;
    }
    switch (session.status) {
      case "running":
        return 2;
      case "closing":
        return 3;
      case "finished":
      case "failed":
        return 4;
      default:
        return 5;
    }
  };

  const timeValue = (ts: string | undefined): number => {
    if (!ts) {
      return 0;
    }
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  return [...sessions].sort((left, right) => {
    const statusDelta = rank(left) - rank(right);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const recencyDelta = timeValue(right.lastEventTs) - timeValue(left.lastEventTs);
    if (recencyDelta !== 0) {
      return recencyDelta;
    }
    return (right.workerLabel ?? right.title).localeCompare(left.workerLabel ?? left.title);
  });
}

function sessionAttentionRank(session: CodingSessionSnapshot): number {
  if (session.waitingOnUser) {
    return 0;
  }
  if (session.needsReview) {
    return 1;
  }
  if (session.workerPhase === "blocked" || session.status === "failed" || session.blockedReason) {
    return 2;
  }
  if (session.status === "running") {
    return 3;
  }
  return 4;
}

function deriveHermesPhase(events: AgentWireEvent[], sessions: CodingSessionSnapshot[]): PhaseState {
  if (sessions.some((session) => session.waitingOnUser)) {
    return {
      title: "Needs Attention",
      tone: "attention",
      subtitle: "Hermes is waiting on a worker decision from you.",
    };
  }
  if (sessions.some((session) => session.status === "failed" || session.workerPhase === "blocked")) {
    return {
      title: "Blocked",
      tone: "attention",
      subtitle: "A worker hit trouble and Hermes is surfacing the next step.",
    };
  }
  const latest = events.find((event) =>
    [
      "assistant.reply",
      "agent.summary",
      "hermes.status",
      "worker.updated",
      "worker.pending_question",
      "terminal.finished",
      "terminal.failed",
      "terminal.started",
    ].includes(event.type),
  );
  if (!latest) {
    return {
      title: "Standing By",
      tone: "calm",
      subtitle: "Hermes is ready to manage the next coding task.",
    };
  }
  if (["assistant.reply", "agent.summary", "terminal.finished"].includes(latest.type)) {
    return {
      title: "Ready",
      tone: "success",
      subtitle: "Hermes has an update ready and the control plane is in sync.",
    };
  }
  if (latest.type === "terminal.failed") {
    return {
      title: "Needs Attention",
      tone: "attention",
      subtitle: "The latest worker run failed and Hermes is flagging it.",
    };
  }
  return {
    title: "Working",
    tone: "working",
    subtitle: "Hermes is tracking active workers on your Mac.",
  };
}

function deriveHeadsetPrompt(
  sessions: CodingSessionSnapshot[],
  pendingSession: CodingSessionSnapshot | undefined,
  attentionSessions: CodingSessionSnapshot[],
  liveSessions: CodingSessionSnapshot[],
  latestHermesUpdate: AgentWireEvent | undefined,
  selectedProjectPath: string,
): HeadsetPromptState {
  if (!selectedProjectPath) {
    return {
      title: "Pick a project",
      detail: "Set the current repo path first so Hermes can open the right worker without extra back-and-forth.",
      tone: "calm",
    };
  }

  if (pendingSession) {
    return {
      title: `Answer ${pendingSession.workerLabel ?? pendingSession.title}`,
      detail:
        pendingSession.pendingQuestion ??
        pendingSession.managerSummary ??
        "Hermes surfaced a worker decision. Approve, reject, or reply from the worker detail panel.",
      tone: "attention",
      sessionId: pendingSession.sessionId,
    };
  }

  const blockedSession = attentionSessions.find((session) => !session.waitingOnUser);
  if (blockedSession) {
    return {
      title: `Inspect ${blockedSession.workerLabel ?? blockedSession.title}`,
      detail:
        blockedSession.blockedReason ??
        blockedSession.managerSummary ??
        blockedSession.lastUpdate ??
        "Hermes surfaced an issue from an active worker. Open the detail panel before sending more work.",
      tone: "attention",
      sessionId: blockedSession.sessionId,
    };
  }

  if (liveSessions.length > 0) {
    const lead = liveSessions[0];
    return {
      title: `Monitor ${lead.workerLabel ?? lead.title}`,
      detail:
        lead.managerSummary ??
        lead.lastUpdate ??
        lead.taskTitle ??
        "Hermes is actively managing work. Open the worker detail if you need more context.",
      tone: "working",
      sessionId: lead.sessionId,
    };
  }

  if (latestHermesUpdate) {
    return {
      title: "Hermes is ready",
      detail: payloadText(latestHermesUpdate.payload, "text") ?? "No active workers right now. Start with a Hermes instruction.",
      tone: "success",
    };
  }

  return {
    title: sessions.length > 0 ? "Review recent work" : "Start a task",
    detail:
      sessions.length > 0
        ? "No live workers right now. Review the latest summary or ask Hermes to open a fresh worker."
        : "Ask Hermes to open Claude or Codex in the selected project.",
    tone: "calm",
  };
}

export function useQuestClient() {
  const socketRef = useRef<WebSocket | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);
  const firstEventTimeoutRef = useRef<number | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenEventOrderRef = useRef<string[]>([]);
  const sessionMapRef = useRef<Map<string, CodingSessionState>>(new Map());
  const avatarResetTimeoutRef = useRef<number | null>(null);

  const [events, setEvents] = useState<AgentWireEvent[]>([]);
  const [sessions, setSessions] = useState<CodingSessionSnapshot[]>([]);
  const [statusText, setStatusText] = useState("Disconnected");
  const [isConnected, setIsConnected] = useState(false);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>("");
  const [avatarState, setAvatarState] = useState<AvatarState>({ mode: "idle" });
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    mode: "idle",
    hasReceivedEvents: false,
  });

  useEffect(() => {
    return () => {
      if (avatarResetTimeoutRef.current !== null) {
        window.clearTimeout(avatarResetTimeoutRef.current);
      }
      if (connectTimeoutRef.current !== null) {
        window.clearTimeout(connectTimeoutRef.current);
      }
      if (firstEventTimeoutRef.current !== null) {
        window.clearTimeout(firstEventTimeoutRef.current);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  function scheduleAvatarReset(delayMs: number) {
    if (avatarResetTimeoutRef.current !== null) {
      window.clearTimeout(avatarResetTimeoutRef.current);
    }
    avatarResetTimeoutRef.current = window.setTimeout(() => {
      setAvatarState((current) =>
        current.mode === "speaking" || current.mode === "listening" || current.mode === "thinking"
          ? { ...current, mode: "idle" }
          : current,
      );
      avatarResetTimeoutRef.current = null;
    }, delayMs);
  }

  function resetState() {
    seenEventIdsRef.current.clear();
    seenEventOrderRef.current = [];
    sessionMapRef.current.clear();
    if (avatarResetTimeoutRef.current !== null) {
      window.clearTimeout(avatarResetTimeoutRef.current);
      avatarResetTimeoutRef.current = null;
    }
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (firstEventTimeoutRef.current !== null) {
      window.clearTimeout(firstEventTimeoutRef.current);
      firstEventTimeoutRef.current = null;
    }
    setEvents([]);
    setSessions([]);
    setSelectedProjectPath("");
    setAvatarState({ mode: "idle" });
    setConnectionState((current) => ({
      mode: "idle",
      targetUrl: current.targetUrl,
      lastConnectedUrl: current.lastConnectedUrl,
      hasReceivedEvents: false,
    }));
  }

  function refreshSessions() {
    setSessions(sortSessions(Array.from(sessionMapRef.current.values())));
  }

  function ingestEvent(event: AgentWireEvent) {
    const id = eventId(event);
    if (seenEventIdsRef.current.has(id)) {
      return;
    }
    seenEventIdsRef.current.add(id);
    seenEventOrderRef.current.push(id);
    if (seenEventOrderRef.current.length > 512) {
      const removed = seenEventOrderRef.current.shift();
      if (removed) {
        seenEventIdsRef.current.delete(removed);
      }
    }

    if (event.type === "project.selected") {
      const nextProjectPath = payloadText(event.payload, "path");
      if (nextProjectPath) {
        setSelectedProjectPath(nextProjectPath);
      }
    }

    if (event.type === "coding_sessions.synced") {
      const sessionCount = payloadInt(event.payload, "session_count") ?? 0;
      const liveCount = payloadInt(event.payload, "live_count") ?? 0;
      setStatusText(
        sessionCount === 0
          ? "Worker board synced. No active workers yet."
          : liveCount > 0
            ? `Worker board synced. ${liveCount} live worker${liveCount === 1 ? "" : "s"} active.`
            : "Worker board synced.",
      );
    }

    if (event.type === "speech.transcript") {
      const transcript = payloadText(event.payload, "text");
      setAvatarState({
        mode: "listening",
        transcript,
        spokenText: undefined,
      });
      scheduleAvatarReset(1800);
    } else if (event.type === "avatar.thinking") {
      const transcript = payloadText(event.payload, "text");
      setAvatarState((current) => ({
        mode: "thinking",
        transcript: transcript ?? current.transcript,
        spokenText: undefined,
      }));
      if (avatarResetTimeoutRef.current !== null) {
        window.clearTimeout(avatarResetTimeoutRef.current);
        avatarResetTimeoutRef.current = null;
      }
    } else if (event.type === "avatar.speaking" || event.type === "assistant.reply") {
      const spokenText = payloadText(event.payload, "text");
      const explicitDurationMs = payloadInt(event.payload, "duration_ms");
      setAvatarState((current) => ({
        mode: "speaking",
        transcript: current.transcript,
        spokenText: spokenText ?? current.spokenText,
      }));
      scheduleAvatarReset(estimateSpeechDurationMs(spokenText, explicitDurationMs));
    }

    const sessionId = event.session_id ?? undefined;
    if (sessionId) {
      const current = sessionMapRef.current.get(sessionId) ?? baseSessionState(sessionId);
      let updated: CodingSessionState = current;

      switch (event.type) {
        case "terminal.started":
        case "session.started":
          updated = applyWorkerPayload(event, {
            ...current,
            title: payloadText(event.payload, "title") ?? current.title,
            repoPath: payloadText(event.payload, "repo_path") ?? current.repoPath,
            command: payloadText(event.payload, "command") ?? current.command,
            logPath: payloadText(event.payload, "log_path") ?? current.logPath,
            pid: payloadInt(event.payload, "pid") ?? current.pid,
            status: "running",
          });
          break;
        case "terminal.output": {
          const line = payloadText(event.payload, "line");
          updated = applyWorkerPayload(event, {
            ...current,
            title: payloadText(event.payload, "title") ?? current.title,
            repoPath: payloadText(event.payload, "repo_path") ?? current.repoPath,
            logPath: payloadText(event.payload, "log_path") ?? current.logPath,
            outputTail: line ? [...current.outputTail, line].slice(-24) : current.outputTail,
          });
          break;
        }
        case "session.output": {
          const line = payloadText(event.payload, "line");
          updated = applyWorkerPayload(event, {
            ...current,
            title: payloadText(event.payload, "title") ?? current.title,
            repoPath: payloadText(event.payload, "repo_path") ?? current.repoPath,
            logPath: payloadText(event.payload, "log_path") ?? current.logPath,
            outputTail: line ? [...current.outputTail, line].slice(-24) : current.outputTail,
          });
          break;
        }
        case "terminal.input": {
          const line = payloadText(event.payload, "text");
          updated = applyWorkerPayload(event, {
            ...current,
            outputTail: line ? [...current.outputTail, `> ${line}`].slice(-24) : current.outputTail,
          });
          break;
        }
        case "terminal.screen":
          updated = applyWorkerPayload(event, {
            ...current,
            title: payloadText(event.payload, "title") ?? current.title,
            repoPath: payloadText(event.payload, "repo_path") ?? current.repoPath,
            command: payloadText(event.payload, "command") ?? current.command,
            logPath: payloadText(event.payload, "log_path") ?? current.logPath,
            screenText: payloadText(event.payload, "screen_text") ?? current.screenText,
            screenRows: payloadInt(event.payload, "screen_rows") ?? current.screenRows,
            screenColumns: payloadInt(event.payload, "screen_columns") ?? current.screenColumns,
          });
          break;
        case "worker.pending_question":
          updated = applyWorkerPayload(event, {
            ...current,
            title: payloadText(event.payload, "title") ?? current.title,
            repoPath: payloadText(event.payload, "repo_path") ?? current.repoPath,
            waitingOnUser: true,
            statusText: payloadText(event.payload, "status_text") ?? "Waiting on you",
            pendingQuestion:
              payloadText(event.payload, "question") ?? current.pendingQuestion,
            lastUpdate:
              payloadText(event.payload, "question") ??
              payloadText(event.payload, "pending_question") ??
              current.lastUpdate,
          });
          break;
        case "worker.updated":
          updated = applyWorkerPayload(event, {
            ...current,
            title: payloadText(event.payload, "title") ?? current.title,
            repoPath: payloadText(event.payload, "repo_path") ?? current.repoPath,
          });
          break;
        case "terminal.finished":
        case "terminal.failed":
        case "session.finished":
        case "session.failed":
          updated = applyWorkerPayload(event, {
            ...current,
            title: payloadText(event.payload, "title") ?? current.title,
            repoPath: payloadText(event.payload, "repo_path") ?? current.repoPath,
            logPath: payloadText(event.payload, "log_path") ?? current.logPath,
            exitCode: payloadInt(event.payload, "exit_code") ?? current.exitCode,
            summary: payloadText(event.payload, "summary") ?? current.summary,
            status: nextStatusForEvent(event.type, current.status),
            waitingOnUser: false,
            pendingQuestion: undefined,
            lastUpdate:
              payloadText(event.payload, "last_update") ??
              payloadText(event.payload, "summary") ??
              current.lastUpdate,
          });
          break;
        case "assistant.reply":
        case "hermes.status":
        case "agent.summary":
          updated = applyWorkerPayload(event, {
            ...current,
            managerSummary:
              payloadText(event.payload, "text") ??
              payloadText(event.payload, "summary") ??
              current.managerSummary,
            lastUpdate:
              payloadText(event.payload, "text") ??
              payloadText(event.payload, "summary") ??
              current.lastUpdate,
            statusText: payloadText(event.payload, "status_text") ?? current.statusText,
          });
          break;
        default:
          break;
      }

      sessionMapRef.current.set(sessionId, {
        ...updated,
        lastEventTs: event.ts,
      });
      refreshSessions();
    }

    if (event.type !== "terminal.screen") {
      setEvents((current) => [event, ...current].slice(0, 160));
    }
  }

  function sendMessage(payload: Record<string, unknown>): boolean {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatusText("Connect to the Mac companion first.");
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  function connect(settings: ConnectionSettings) {
    const previousSocket = socketRef.current;
    socketRef.current = null;
    previousSocket?.close();
    resetState();

    const scheme = settings.scheme ?? (window.location.protocol === "https:" ? "wss" : "ws");
    const targetUrl = settings.url ?? `${scheme}://${settings.host}:${settings.port}`;
    const socket = new WebSocket(targetUrl);
    socketRef.current = socket;
    setStatusText(`Connecting to ${targetUrl}...`);
    setIsConnected(false);
    setConnectionState((current) => ({
      ...current,
      mode: "connecting",
      targetUrl,
      lastError: undefined,
      hasReceivedEvents: false,
      lastEventTs: undefined,
    }));
    connectTimeoutRef.current = window.setTimeout(() => {
      if (socketRef.current !== socket) {
        return;
      }
      setIsConnected(false);
      setStatusText(`Connection to ${targetUrl} timed out.`);
      setConnectionState((current) => ({
        ...current,
        mode: "error",
        targetUrl,
        lastError: `Timed out while connecting to ${targetUrl}.`,
      }));
      socketRef.current = null;
      socket.close();
      connectTimeoutRef.current = null;
    }, 5000);

    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) {
        return;
      }
      if (connectTimeoutRef.current !== null) {
        window.clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      setIsConnected(true);
      setStatusText(`Connected to ${targetUrl}`);
      setConnectionState((current) => ({
        ...current,
        mode: "connected",
        targetUrl,
        lastConnectedUrl: targetUrl,
        lastError: undefined,
      }));
      firstEventTimeoutRef.current = window.setTimeout(() => {
        if (socketRef.current !== socket) {
          return;
        }
        setStatusText("Connected, but Hermes has not sent any events yet.");
        setConnectionState((current) =>
          current.hasReceivedEvents
            ? current
            : {
                ...current,
                lastError:
                  "The socket opened, but no events arrived yet. Try Refresh Workers, switch connection mode, or restart the Mac companion.",
              },
        );
        firstEventTimeoutRef.current = null;
      }, 3500);
      sendMessage({ type: "coding_sessions.sync", payload: {} });
    });

    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) {
        return;
      }
      if (connectTimeoutRef.current !== null) {
        window.clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      if (firstEventTimeoutRef.current !== null) {
        window.clearTimeout(firstEventTimeoutRef.current);
        firstEventTimeoutRef.current = null;
      }
      setIsConnected(false);
      setStatusText("Disconnected");
      setConnectionState((current) => ({
        ...current,
        mode: current.mode === "error" ? "error" : "idle",
      }));
    });

    socket.addEventListener("error", () => {
      if (socketRef.current !== socket) {
        return;
      }
      if (connectTimeoutRef.current !== null) {
        window.clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      if (firstEventTimeoutRef.current !== null) {
        window.clearTimeout(firstEventTimeoutRef.current);
        firstEventTimeoutRef.current = null;
      }
      setIsConnected(false);
      const failureCopy = connectionFailureCopy(targetUrl);
      setStatusText(
        targetUrl.includes("/xr-agent-events")
          ? "Bridge failed. Start the Mac companion or switch to direct."
          : "WebSocket connection failed.",
      );
      setConnectionState((current) => ({
        ...current,
        mode: "error",
        targetUrl,
        lastError: failureCopy,
      }));
    });

    socket.addEventListener("message", (message) => {
      if (socketRef.current !== socket) {
        return;
      }
      try {
        const event = JSON.parse(String(message.data)) as AgentWireEvent;
        if (!event || typeof event.type !== "string" || typeof event.ts !== "string") {
          return;
        }
        setConnectionState((current) => ({
          ...current,
          mode: "connected",
          hasReceivedEvents: true,
          lastEventTs: event.ts,
          lastError: undefined,
        }));
        if (firstEventTimeoutRef.current !== null) {
          window.clearTimeout(firstEventTimeoutRef.current);
          firstEventTimeoutRef.current = null;
        }
        ingestEvent(event);
      } catch {
        setStatusText("Received an unreadable event from the Mac companion.");
        setConnectionState((current) => ({
          ...current,
          mode: "error",
          lastError: "Received an unreadable event from the Mac companion.",
        }));
      }
    });
  }

  function disconnect() {
    const socket = socketRef.current;
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (firstEventTimeoutRef.current !== null) {
      window.clearTimeout(firstEventTimeoutRef.current);
      firstEventTimeoutRef.current = null;
    }
    socketRef.current = null;
    socket?.close();
    resetState();
    setIsConnected(false);
    setStatusText("Disconnected");
    setConnectionState((current) => ({
      ...current,
      mode: "idle",
      hasReceivedEvents: false,
      lastError: undefined,
      lastEventTs: undefined,
    }));
  }

  function noteStatus(message: string) {
    setStatusText(message);
  }

  function sendHermesCommand(text: string, repoPath?: string) {
    const sent = sendMessage({
      type: "voice.command",
      payload: {
        text,
        ...(repoPath ? { repo_path: repoPath } : {}),
      },
    });
    if (sent) {
      setStatusText("Sent command to Hermes.");
    }
    return sent;
  }

  function sendVoiceAudio(audioBase64: string, mimeType: string, repoPath?: string) {
    const sent = sendMessage({
      type: "voice.audio",
      payload: {
        audio_base64: audioBase64,
        mime_type: mimeType,
        ...(repoPath ? { repo_path: repoPath } : {}),
      },
    });
    if (sent) {
      setStatusText("Sent microphone audio to Hermes.");
    }
    return sent;
  }

  function openCodingSession(tool: CodingWorkerTool, repoPath?: string, options: OpenCodingSessionOptions = {}) {
    const sent = sendMessage({
      type: "coding_session.open",
      payload: {
        intent: intentForWorkerTool(tool),
        repo_path: repoPath || ".",
        ...(options.dangerouslySkipPermissions ? { dangerously_skip_permissions: true } : {}),
      },
    });
    if (sent) {
      const label = tool === "claude" ? "Claude" : tool === "codex" ? "Codex" : "Hermes";
      setStatusText(`Opening ${label} worker...`);
    }
    return sent;
  }

  function requestSessionSync() {
    const sent = sendMessage({ type: "coding_sessions.sync", payload: {} });
    if (sent) {
      setStatusText("Refreshing worker board...");
    }
    return sent;
  }

  function sendWorkerReply(sessionId: string, text: string, routeViaManager = true) {
    const sent = sendMessage({
      type: "worker.reply",
      payload: {
        session_id: sessionId,
        text,
        route_via_manager: routeViaManager,
      },
    });
    if (sent) {
      setStatusText(routeViaManager ? "Hermes is routing your worker reply." : "Sent direct worker reply.");
    }
    return sent;
  }

  function sendDirectWorkerInput(sessionId: string, text: string) {
    const sent = sendMessage({
      type: "terminal.input",
      payload: {
        session_id: sessionId,
        text,
      },
    });
    if (sent) {
      setStatusText("Sent direct input to the worker.");
    }
    return sent;
  }

  function requestProjectPicker(startingPath?: string) {
    const sent = sendMessage({
      type: "project.pick_folder",
      payload: {
        ...(startingPath ? { starting_path: startingPath } : {}),
      },
    });
    if (sent) {
      setStatusText("Opening the Mac project picker...");
    }
    return sent;
  }

  const signalEvents = events.filter(isHighSignalEvent);
  const pendingSession = sessions.find((session) => session.waitingOnUser);
  const liveSessions = sessions.filter((session) => session.status === "running");
  const attentionSessions = [...sessions]
    .sort((left, right) => sessionAttentionRank(left) - sessionAttentionRank(right))
    .filter((session) =>
      session.waitingOnUser
      || session.needsReview
      || session.workerPhase === "blocked"
      || session.status === "failed"
      || Boolean(session.blockedReason),
    );
  const latestHermesUpdate = events.find((event) =>
    ["assistant.reply", "agent.summary", "hermes.status"].includes(event.type),
  );
  const latestAssistantReply = events.find((event) => event.type === "assistant.reply");
  const hermesPhase = deriveHermesPhase(events, sessions);
  const prioritySession = pendingSession ?? attentionSessions[0] ?? liveSessions[0] ?? sessions[0];
  const headsetPrompt = deriveHeadsetPrompt(
    sessions,
    pendingSession,
    attentionSessions,
    liveSessions,
    latestHermesUpdate,
    selectedProjectPath,
  );
  const workerStats = {
    total: sessions.length,
    live: liveSessions.length,
    attention: attentionSessions.length,
  };

  return {
    attentionSessions,
    avatarState,
    connectionState,
    events,
    headsetPrompt,
    hermesPhase,
    isConnected,
    latestAssistantReply,
    latestHermesUpdate,
    liveSessions,
    pendingSession,
    prioritySession,
    openCodingSession,
    requestProjectPicker,
    requestSessionSync,
    selectedProjectPath,
    sendDirectWorkerInput,
    sendHermesCommand,
    sendVoiceAudio,
    sendWorkerReply,
    sessions,
    signalEvents,
    statusText,
    workerStats,
    noteStatus,
    connect,
    disconnect,
  };
}
