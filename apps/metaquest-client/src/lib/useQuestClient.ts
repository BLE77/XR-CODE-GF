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

interface CodingSessionState extends CodingSessionSnapshot {}

interface PhaseState {
  title: string;
  tone: "calm" | "working" | "attention" | "success";
  subtitle: string;
}

function nextStatusForEvent(eventType: string, current: CodingSessionStatus): CodingSessionStatus {
  switch (eventType) {
    case "terminal.finished":
      return "finished";
    case "terminal.failed":
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
  return {
    ...state,
    intent: payloadText(event.payload, "intent") ?? state.intent,
    workerLabel: payloadText(event.payload, "worker_label") ?? state.workerLabel,
    taskTitle: payloadText(event.payload, "task_title") ?? state.taskTitle,
    workerPhase: payloadText(event.payload, "worker_phase") ?? state.workerPhase,
    statusText: payloadText(event.payload, "status_text") ?? state.statusText,
    managerSummary: payloadText(event.payload, "manager_summary") ?? state.managerSummary,
    waitingOnUser: payloadBool(event.payload, "waiting_on_user") ?? state.waitingOnUser,
    needsReview: payloadBool(event.payload, "needs_review") ?? state.needsReview,
    blockedReason: payloadText(event.payload, "blocked_reason") ?? state.blockedReason,
    pendingQuestion:
      pendingQuestion === undefined ? state.pendingQuestion : pendingQuestion || undefined,
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

function sortSessions(sessions: CodingSessionSnapshot[]): CodingSessionSnapshot[] {
  const rank = (status: CodingSessionStatus): number => {
    switch (status) {
      case "running":
        return 0;
      case "closing":
        return 1;
      case "finished":
      case "failed":
        return 2;
      default:
        return 3;
    }
  };

  return [...sessions].sort((left, right) => {
    const statusDelta = rank(left.status) - rank(right.status);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    return (right.workerLabel ?? right.title).localeCompare(left.workerLabel ?? left.title);
  });
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

export function useQuestClient() {
  const socketRef = useRef<WebSocket | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenEventOrderRef = useRef<string[]>([]);
  const sessionMapRef = useRef<Map<string, CodingSessionState>>(new Map());

  const [events, setEvents] = useState<AgentWireEvent[]>([]);
  const [sessions, setSessions] = useState<CodingSessionSnapshot[]>([]);
  const [statusText, setStatusText] = useState("Disconnected");
  const [isConnected, setIsConnected] = useState(false);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>("");

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  function resetState() {
    seenEventIdsRef.current.clear();
    seenEventOrderRef.current = [];
    sessionMapRef.current.clear();
    setEvents([]);
    setSessions([]);
    setSelectedProjectPath("");
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

    const sessionId = event.session_id ?? undefined;
    if (sessionId) {
      const current = sessionMapRef.current.get(sessionId) ?? baseSessionState(sessionId);
      let updated: CodingSessionState = current;

      switch (event.type) {
        case "terminal.started":
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
          updated = applyWorkerPayload(event, current);
          break;
        default:
          break;
      }

      sessionMapRef.current.set(sessionId, updated);
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

    const socket = new WebSocket(`ws://${settings.host}:${settings.port}`);
    socketRef.current = socket;
    setStatusText(`Connecting to ${settings.host}:${settings.port}...`);
    setIsConnected(false);

    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) {
        return;
      }
      setIsConnected(true);
      setStatusText(`Connected to ${settings.host}:${settings.port}`);
      sendMessage({ type: "coding_sessions.sync", payload: {} });
    });

    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) {
        return;
      }
      setIsConnected(false);
      setStatusText("Disconnected");
    });

    socket.addEventListener("error", () => {
      if (socketRef.current !== socket) {
        return;
      }
      setIsConnected(false);
      setStatusText("WebSocket connection failed.");
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
        ingestEvent(event);
      } catch {
        setStatusText("Received an unreadable event from the Mac companion.");
      }
    });
  }

  function disconnect() {
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    resetState();
    setIsConnected(false);
    setStatusText("Disconnected");
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
  const latestHermesUpdate = events.find((event) =>
    ["assistant.reply", "agent.summary", "hermes.status"].includes(event.type),
  );
  const hermesPhase = deriveHermesPhase(events, sessions);

  return {
    events,
    hermesPhase,
    isConnected,
    latestHermesUpdate,
    liveSessions,
    pendingSession,
    requestProjectPicker,
    requestSessionSync,
    selectedProjectPath,
    sendDirectWorkerInput,
    sendHermesCommand,
    sendWorkerReply,
    sessions,
    signalEvents,
    statusText,
    connect,
    disconnect,
  };
}
