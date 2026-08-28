import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuestClient } from "./lib/useQuestClient";
import {
  eventId,
  formatEventTime,
  payloadBool,
  payloadInt,
  payloadText,
  signalLabel,
  summarizeSignal,
  type AgentWireEvent,
  type CodingSessionSnapshot,
} from "./lib/protocol";

const ImmersiveHermesStage = lazy(async () => {
  const module = await import("./ImmersiveHermesStage");
  return { default: module.ImmersiveHermesStage };
});

const SETTINGS_KEY = "xr-agent-metaquest-settings";
const SPEECH_KEY = "xr-agent-metaquest-speech-enabled";
const DEVICE_TOKEN_KEY = "xr-agent-device-token";
const XR_VOICE_TOGGLE_EVENT = "xr-agent-voice-toggle-request";
const BRIDGE_ENABLED =
  import.meta.env.DEV || String(import.meta.env.VITE_XR_ENABLE_BRIDGE ?? "").toLowerCase() === "true";

type StoredSettings = {
  connectionMode: "bridge" | "direct";
  scheme: "ws" | "wss";
  host: string;
  port: number;
  repoPath: string;
};

type WorkerOpenTool = "claude" | "codex" | "hermes" | "kimi";
type WorkerOpenOptions = {
  dangerouslySkipPermissions?: boolean;
};
type BrowserSpeechRecognition = InstanceType<NonNullable<Window["SpeechRecognition"]>>;
type XrEntryStatus = {
  state: string;
  label: string;
  summary: string;
  message: string;
  canRequest: boolean;
};

type RealtimeVoiceConnection = {
  requestId: string;
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  mediaStream: MediaStream;
  audioElement: HTMLAudioElement;
  sessionConfig?: Record<string, unknown>;
};

type PendingRealtimeVoiceRequest = {
  requestId: string;
  repoPath?: string;
  sent: boolean;
};

const DEFAULT_SCHEME: StoredSettings["scheme"] = window.location.protocol === "https:" ? "wss" : "ws";

function canAccessMicrophone(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function canCaptureMicrophone(): boolean {
  return canAccessMicrophone() && typeof MediaRecorder !== "undefined";
}

function canStartRealtimeVoice(): boolean {
  return canAccessMicrophone() && "RTCPeerConnection" in window;
}

function preferredVoiceMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return (
    [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ""
  );
}

function normalizeRealtimeRouteText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

const REALTIME_HERMES_LOCAL_ONLY_UTTERANCES = new Set([
  "hi",
  "hey",
  "hello",
  "yo",
  "ok",
  "okay",
  "yeah",
  "yep",
  "yes",
  "no",
  "nope",
  "cool",
  "nice",
  "thanks",
  "thank you",
  "got it",
  "never mind",
  "nevermind",
  "haha",
  "hahaha",
  "lol",
]);

const REALTIME_HERMES_ACTION_PATTERN =
  /\b(open|launch|start|tell|ask|send|close|run|build|test|fix|inspect|check|status|list|summarize|read|look|watch|see|show|hide|move|grab|drag|place|sit|stand|walk|go|scan|classify|use|make|change|update|debug|review|remember|remind|save|recall|forget|claude|codex|hermes|kimi|worker|workers|agent|agents|terminal|session|panel|panels|ui|xr|quest|yuki|voice|personality|persona|behavior|default|sassy|spicy|flirty|sassier|flirtier|preference|preferences|profile|memory|memories|reminder|reminders|honcho|screen|room|camera|browser|website|code|repo|git)\b|what happened/i;

function shouldRouteRealtimeTranscriptToHermes(text: string): boolean {
  const normalized = normalizeRealtimeRouteText(text).replace(/[.!?]+$/g, "");
  if (!normalized || REALTIME_HERMES_LOCAL_ONLY_UTTERANCES.has(normalized)) {
    return false;
  }
  if (REALTIME_HERMES_ACTION_PATTERN.test(normalized)) {
    return true;
  }
  const wordCount = normalized.split(" ").filter(Boolean).length;
  return wordCount >= 3;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read microphone audio."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function loadSettings(): StoredSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return {
        connectionMode: BRIDGE_ENABLED ? "bridge" : "direct",
        scheme: DEFAULT_SCHEME,
        host: window.location.hostname || "127.0.0.1",
        port: 8765,
        repoPath: "",
      };
    }
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    return {
      connectionMode:
        parsed.connectionMode === "bridge" && !BRIDGE_ENABLED
          ? "direct"
          : parsed.connectionMode ?? (BRIDGE_ENABLED ? "bridge" : "direct"),
      scheme: parsed.scheme ?? DEFAULT_SCHEME,
      host: parsed.host || window.location.hostname || "127.0.0.1",
      port: parsed.port || 8765,
      repoPath: parsed.repoPath || "",
    };
  } catch {
    return {
      connectionMode: BRIDGE_ENABLED ? "bridge" : "direct",
      scheme: DEFAULT_SCHEME,
      host: window.location.hostname || "127.0.0.1",
      port: 8765,
      repoPath: "",
    };
  }
}

function toneClass(tone: string): string {
  return `tone-${tone}`;
}

function deriveHermesCharacterState(
  isListening: boolean,
  avatarMode: "idle" | "listening" | "thinking" | "speaking",
  detailSession: CodingSessionSnapshot | undefined,
  tone: "calm" | "working" | "attention" | "success",
): "idle" | "listening" | "working" | "alert" | "ready" {
  if (isListening || avatarMode === "listening" || avatarMode === "speaking") {
    return "listening";
  }
  if (detailSession?.waitingOnUser || tone === "attention") {
    return "alert";
  }
  if (avatarMode === "thinking" || tone === "working") {
    return "working";
  }
  if (tone === "success") {
    return "ready";
  }
  return "idle";
}

function loadSpeechEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(SPEECH_KEY);
    if (raw === null) {
      return true;
    }
    return raw !== "false";
  } catch {
    return true;
  }
}

function loadDeviceToken(): string {
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function launchParams(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

function isPhoneBodyLaunch(): boolean {
  const params = launchParams();
  return params.get("phone") === "1" || params.get("mode") === "phone" || params.get("xrbody") === "1";
}

function requestedMobilePlatform(): "android" | "ios" | "auto" {
  const platform = (launchParams().get("platform") ?? launchParams().get("mobilePlatform") ?? "auto").toLowerCase();
  return platform === "android" || platform === "ios" ? platform : "auto";
}

function detectedMobilePlatform(): "android" | "ios" | "phone" {
  const userAgent = navigator.userAgent;
  if (/Android/i.test(userAgent)) {
    return "android";
  }
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return "ios";
  }
  return "phone";
}

function mobilePlatformLabel(): string {
  const platform = requestedMobilePlatform();
  const resolved = platform === "auto" ? detectedMobilePlatform() : platform;
  switch (resolved) {
    case "android":
      return "Android";
    case "ios":
      return "iPhone";
    default:
      return "Phone";
  }
}

function sessionStatusCopy(session: CodingSessionSnapshot): string {
  if (session.waitingOnUser) {
    return "Waiting on you";
  }
  if (session.workerPhase) {
    return session.workerPhase.replaceAll("_", " ");
  }
  return session.status;
}

function sessionLabel(session: CodingSessionSnapshot | undefined): string {
  if (!session) {
    return "No worker selected";
  }
  return session.workerLabel ?? session.title;
}

function sessionStreamPreview(session: CodingSessionSnapshot | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  const screenLine = session.screenText
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0];
  const outputLine = session.outputTail.map((line) => line.trim()).filter(Boolean).slice(-1)[0];
  return screenLine ?? outputLine;
}

function sessionLeadCopy(session: CodingSessionSnapshot | undefined): string {
  if (!session) {
    return "Hermes is ready to open a worker when you are.";
  }
  return (
    session.pendingQuestion ??
    session.blockedReason ??
    sessionStreamPreview(session) ??
    session.managerSummary ??
    session.lastUpdate ??
    session.taskTitle ??
    "Hermes is tracking this worker."
  );
}

function realtimeHermesNarrationText(event: AgentWireEvent): string | undefined {
  const text = payloadText(event.payload, "text");
  const summary = payloadText(event.payload, "summary");
  const title = payloadText(event.payload, "title");
  const workerLabel = payloadText(event.payload, "worker_label");
  const label = workerLabel ?? title ?? "Hermes";

  switch (event.type) {
    case "assistant.reply":
    case "agent.summary":
      return text ?? summary;
    case "terminal.started":
    case "session.started":
      return title ? `${title} opened and is starting now.` : "A worker session opened and is starting now.";
    case "worker.pending_question":
      return text ?? summary ?? `${label} needs your input before continuing.`;
    case "terminal.failed":
    case "session.failed":
      return summary ?? text ?? `${label} hit a failure.`;
    case "terminal.finished":
    case "session.finished":
      return summary ?? text ?? `${label} finished.`;
    default:
      return undefined;
  }
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) {
    return "No events yet";
  }
  return formatEventTime(ts);
}

export default function App() {
  const client = useQuestClient();
  const initialSettings = loadSettings();
  const [connectionMode, setConnectionMode] = useState<"bridge" | "direct">(initialSettings.connectionMode);
  const [host, setHost] = useState(initialSettings.host);
  const [scheme, setScheme] = useState<"ws" | "wss">(initialSettings.scheme);
  const [port, setPort] = useState(String(initialSettings.port));
  const [repoPath, setRepoPath] = useState(initialSettings.repoPath);
  const [deviceToken, setDeviceToken] = useState(loadDeviceToken);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>("");
  const [hermesPrompt, setHermesPrompt] = useState("");
  const [workerReply, setWorkerReply] = useState("");
  const [directInput, setDirectInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(loadSpeechEnabled);
  const [speechPulseAt, setSpeechPulseAt] = useState(0);
  const [speechSpeaking, setSpeechSpeaking] = useState(false);
  const [xrEntryStatus, setXrEntryStatus] = useState<XrEntryStatus>({
    state: "checking",
    label: "Enter XR",
    summary: "Stage loading",
    message: "Yuki stage is loading.",
    canRequest: false,
  });
  const lastSpokenReplyIdRef = useRef("");
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const activeMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const activeMediaStreamRef = useRef<MediaStream | null>(null);
  const activeRealtimeVoiceRef = useRef<RealtimeVoiceConnection | null>(null);
  const mediaRecorderChunksRef = useRef<BlobPart[]>([]);
  const pendingHermesCommandRef = useRef<{ text: string; repoPath?: string } | null>(null);
  const pendingVoiceAudioRef = useRef<{ audioBase64: string; mimeType: string; repoPath?: string } | null>(null);
  const pendingRealtimeVoiceRef = useRef<PendingRealtimeVoiceRequest | null>(null);
  const handledRealtimeSessionEventsRef = useRef<Set<string>>(new Set());
  const handledRealtimeFunctionCallsRef = useRef<Set<string>>(new Set());
  const lastRealtimeHermesRouteRef = useRef<{ normalized: string; at: number } | null>(null);
  const realtimeResponseInProgressRef = useRef(false);
  const pendingRealtimeFunctionResponseRef = useRef(false);
  const realtimeNarrationEventIdsRef = useRef<Set<string>>(new Set());
  const lastRealtimeNarrationRef = useRef<{ normalized: string; at: number } | null>(null);
  const queuedRealtimeNarrationRef = useRef<{ text: string; instructions: string } | null>(null);
  const realtimeNarrationTimerRef = useRef<number | null>(null);
  const lastRealtimeVoiceActivityAtRef = useRef(0);
  const lastRealtimeIdleBanterAtRef = useRef(0);
  const voiceDesiredRef = useRef(false);
  const voiceReconnectTimerRef = useRef<number | null>(null);
  const voiceReconnectAttemptRef = useRef(0);
  const lastRealtimeRepoPathRef = useRef<string | undefined>(undefined);
  const pendingWorkerOpenRef = useRef<
    { tool: WorkerOpenTool; repoPath: string; dangerouslySkipPermissions?: boolean } | null
  >(null);
  const autoBridgeConnectRef = useRef(false);
  const appLiveContextRef = useRef<Record<string, unknown>>({});
  const voiceToggleRequestRef = useRef<() => void>(() => undefined);

  const detailSession =
    client.sessions.find((session) => session.sessionId === selectedWorkerId) ??
    client.prioritySession;
  const workerFocusList =
    detailSession && !client.liveSessions.some((session) => session.sessionId === detailSession.sessionId)
      ? [detailSession, ...client.liveSessions]
      : client.liveSessions.length > 0
        ? client.liveSessions
        : client.sessions;
  const characterState = deriveHermesCharacterState(
    isListening,
    client.avatarState.mode,
    detailSession,
    client.hermesPhase.tone,
  );
  const selectedWorkerIndex = detailSession
    ? workerFocusList.findIndex((session) => session.sessionId === detailSession.sessionId)
    : -1;
  const previousWorker = selectedWorkerIndex > 0 ? workerFocusList[selectedWorkerIndex - 1] : undefined;
  const nextWorker =
    selectedWorkerIndex >= 0 && selectedWorkerIndex < workerFocusList.length - 1
      ? workerFocusList[selectedWorkerIndex + 1]
      : undefined;
  const detailSignals = detailSession
    ? client.signalEvents.filter(
        (event) => event.session_id === detailSession.sessionId,
      )
    : client.signalEvents;
  const quickReplySuggestions = [
    "approve",
    "hold off and summarize the risk first",
    "tell me the tradeoffs before you continue",
    "proceed carefully and keep me updated",
  ];
  const latestAssistantText =
    client.avatarState.spokenText ??
    (client.latestAssistantReply ? summarizeSignal(client.latestAssistantReply) : undefined);
  const latestTranscript = client.avatarState.transcript;
  const phoneBodyLaunch = isPhoneBodyLaunch();
  const bodyDeviceLabel = phoneBodyLaunch ? `${mobilePlatformLabel()} XR Body` : "Quest";
  const bridgeScheme = window.location.protocol === "https:" ? "wss" : "ws";
  const pairingCode = launchParams().get("pair") ?? "";
  const withSocketAuth = (url: string) => {
    const target = new URL(url);
    if (deviceToken) {
      target.searchParams.set("token", deviceToken);
    } else if (pairingCode) {
      target.searchParams.set("pair", pairingCode);
    }
    return target.toString();
  };
  const bridgeTargetUrl = withSocketAuth(`${bridgeScheme}://${window.location.host}/xr-agent-events`);
  const directTargetUrl = withSocketAuth(`${scheme}://${host.trim() || "127.0.0.1"}:${Number.parseInt(port, 10) || 8765}`);
  const effectiveTargetUrl = connectionMode === "bridge" ? bridgeTargetUrl : directTargetUrl;
  const directModeUsesLoopback = ["localhost", "127.0.0.1"].includes((host.trim() || "").toLowerCase());
  const directModeMixedContentRisk = connectionMode === "direct" && window.location.protocol === "https:" && scheme === "ws";
  const connectionGuidanceTitle =
    connectionMode === "bridge" ? "Bridge through this page origin" : "Connect directly to the Mac companion";
  const connectionGuidanceBody =
    connectionMode === "bridge"
      ? "Use bridge mode only when this page host is actively proxying /xr-agent-events to Hermes, like Vite dev or an explicit reverse proxy. If bridge mode fails, switch to direct and enter the Mac LAN IP."
      : phoneBodyLaunch
        ? `Use direct mode when this ${bodyDeviceLabel} needs to talk straight to the Mac companion. On phone, localhost points at the phone, not your Mac.`
        : "Use direct mode when Quest Browser needs to talk straight to the Mac companion. On headset, localhost points at the headset, not your Mac.";
  const connectionWarning = !BRIDGE_ENABLED && connectionMode === "bridge"
    ? "Bridge mode is disabled in this build because this page host is not guaranteed to proxy /xr-agent-events. Use direct mode unless you explicitly enable bridge support."
    : connectionMode === "direct" && directModeUsesLoopback
    ? phoneBodyLaunch
      ? `Direct mode is still pointing at localhost. On ${bodyDeviceLabel}, that means the phone itself, so switch host to your Mac LAN IP.`
      : "Direct mode is still pointing at localhost. On Quest that means the headset itself, so switch host to your Mac LAN IP."
    : directModeMixedContentRisk
      ? "This page is running over HTTPS while direct mode is set to ws. Browsers can block mixed-content sockets. Use bridge mode or switch direct mode to wss."
      : client.connectionState.lastError;
  const compactConnectionStatus = client.isConnected
    ? "Connected"
    : client.connectionState.mode === "connecting"
      ? "Connecting"
      : client.connectionState.mode === "error"
        ? "Connection issue"
        : "Disconnected";
  const miniConnectionStatus = client.isConnected
    ? "Online"
    : client.connectionState.mode === "connecting"
      ? "Linking"
      : client.connectionState.mode === "error"
        ? "Issue"
        : "Offline";
  const connectionDetail = client.isConnected
    ? client.statusText
    : connectionWarning ?? client.statusText;
  const xrDeckLabel =
    xrEntryStatus.state === "active"
      ? "XR Live"
      : xrEntryStatus.state === "unsupported"
        ? "Phone Mode"
        : xrEntryStatus.state === "failed"
          ? "Recheck XR"
          : xrEntryStatus.state === "checking" || xrEntryStatus.state === "entering"
            ? xrEntryStatus.label
            : "Enter XR";
  const xrDeckSummary = xrEntryStatus.summary || "Immersive mode";
  const mostUsefulAction =
    client.pendingSession
      ? {
          label: "Focus Pending Decision",
          action: () => focusWorker(client.pendingSession?.sessionId),
        }
      : client.liveSessions.length === 0
        ? {
            label: "Open Claude Full Access",
            action: () => openWorkerSession("claude", { dangerouslySkipPermissions: true }),
          }
        : {
            label: "Focus Active Worker",
            action: () => focusWorker(detailSession?.sessionId ?? client.prioritySession?.sessionId),
          };
  const secondaryAction =
    client.liveSessions.length === 0
      ? {
          label: "Open Kimi Here",
          action: () => openWorkerSession("kimi"),
        }
      : {
          label: "What Needs Me Next?",
          action: () => sendSuggestedPrompt("What needs me next across the active workers?"),
        };
  const latestVoicePayload = client.latestAssistantReply?.payload;
  const latestVoiceProvider = latestVoicePayload
    ? payloadText(latestVoicePayload, "voice_provider") ?? "browser-fallback"
    : "idle";
  const latestVoiceTransport = latestVoicePayload
    ? payloadText(latestVoicePayload, "voice_transport") ??
      payloadText(latestVoicePayload, "speech_delivery") ??
      "text"
    : "waiting";
  const latestVoiceLatencyMode = latestVoicePayload
    ? payloadText(latestVoicePayload, "voice_latency_mode") ?? "standard"
    : "idle";
  const latestVoiceSynthesisMs = latestVoicePayload
    ? payloadInt(latestVoicePayload, "voice_synthesis_ms")
    : undefined;
  const backendAudioPending = latestVoicePayload
    ? payloadBool(latestVoicePayload, "backend_audio_pending") === true
    : false;
  const voiceStatusTitle = backendAudioPending
    ? "Yuki voice rendering"
    : speechSpeaking
      ? latestVoiceProvider === "elevenlabs"
        ? "Yuki speaking"
        : "Browser voice"
      : isListening
        ? "Listening"
        : voiceConnecting
          ? "Voice connecting"
        : voiceAvailable
          ? "Voice ready"
          : "Voice unavailable";
  const voiceStatusDetail = backendAudioPending
    ? "Holding browser fallback so the ElevenLabs voice does not double-speak."
    : latestVoiceProvider === "elevenlabs"
      ? `${latestVoiceLatencyMode} via ${latestVoiceTransport}${
          latestVoiceSynthesisMs ? ` in ${latestVoiceSynthesisMs} ms` : ""
        }`
      : voiceAvailable
        ? "Mic can route speech to Hermes; replies use backend audio when available."
        : `Open the secure HTTPS ${phoneBodyLaunch ? "phone XR body URL" : "Quest URL"} to enable microphone capture.`;
  const nextActionTone = client.headsetPrompt.tone === "attention"
    ? "tone-attention"
    : client.headsetPrompt.tone === "working"
      ? "tone-working"
      : client.headsetPrompt.tone === "success"
        ? "tone-success"
        : "tone-calm";

  useEffect(() => {
    const recognizerClass = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setVoiceAvailable(Boolean(recognizerClass) || canAccessMicrophone());
  }, []);

  useEffect(() => {
    const handleXrStatus = (event: Event) => {
      const detail = (event as CustomEvent<XrEntryStatus>).detail;
      if (!detail) {
        return;
      }
      setXrEntryStatus(detail);
    };

    window.addEventListener("xr-agent-xr-status", handleXrStatus);
    return () => {
      window.removeEventListener("xr-agent-xr-status", handleXrStatus);
    };
  }, []);

  useEffect(() => {
    if (client.selectedProjectPath) {
      setRepoPath(client.selectedProjectPath);
    }
  }, [client.selectedProjectPath]);

  useEffect(() => {
    if (!detailSession) {
      setSelectedWorkerId("");
      return;
    }
    const selectedSession = selectedWorkerId
      ? client.sessions.find((session) => session.sessionId === selectedWorkerId)
      : undefined;
    const selectedIsLive = selectedSession
      ? client.liveSessions.some((session) => session.sessionId === selectedSession.sessionId)
      : false;
    const selectedIsStaleFinished = selectedSession
      ? !selectedIsLive && (selectedSession.status === "finished" || selectedSession.status === "failed")
      : false;
    if (
      !selectedWorkerId ||
      !selectedSession ||
      (client.liveSessions.length > 0 && selectedIsStaleFinished)
    ) {
      setSelectedWorkerId(detailSession.sessionId);
    }
  }, [client.liveSessions, client.sessions, detailSession, selectedWorkerId]);

  useEffect(() => {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        host,
        connectionMode,
        scheme,
        port: Number.parseInt(port, 10) || 8765,
        repoPath,
      }),
    );
  }, [connectionMode, host, port, repoPath, scheme]);

  useEffect(() => {
    window.localStorage.setItem(SPEECH_KEY, speechEnabled ? "true" : "false");
  }, [speechEnabled]);

  useEffect(() => {
    return () => {
      voiceDesiredRef.current = false;
      if (voiceReconnectTimerRef.current !== null) {
        window.clearTimeout(voiceReconnectTimerRef.current);
        voiceReconnectTimerRef.current = null;
      }
      activeAudioRef.current?.pause();
      activeAudioRef.current = null;
      activeUtteranceRef.current = null;
      try {
        activeRecognitionRef.current?.stop();
      } catch {
        // Browser speech engines can throw if stop lands after an implicit end.
      }
      activeRecognitionRef.current = null;
      const recorder = activeMediaRecorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        try {
          if (recorder.state !== "inactive") {
            recorder.stop();
          }
        } catch {
          // MediaRecorder can throw if the track ended first.
        }
      }
      activeMediaRecorderRef.current = null;
      mediaRecorderChunksRef.current = [];
      activeMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      activeMediaStreamRef.current = null;
      const realtime = activeRealtimeVoiceRef.current;
      if (realtime) {
        realtime.dataChannel.close();
        realtime.peerConnection.close();
        realtime.mediaStream.getTracks().forEach((track) => track.stop());
        realtime.audioElement.remove();
      }
      activeRealtimeVoiceRef.current = null;
      handledRealtimeFunctionCallsRef.current.clear();
      realtimeResponseInProgressRef.current = false;
      pendingRealtimeFunctionResponseRef.current = false;
      realtimeNarrationEventIdsRef.current.clear();
      lastRealtimeNarrationRef.current = null;
      queuedRealtimeNarrationRef.current = null;
      lastRealtimeVoiceActivityAtRef.current = 0;
      lastRealtimeIdleBanterAtRef.current = 0;
      if (realtimeNarrationTimerRef.current !== null) {
        window.clearTimeout(realtimeNarrationTimerRef.current);
        realtimeNarrationTimerRef.current = null;
      }
      setVoiceConnecting(false);
      setSpeechSpeaking(false);
      setIsListening(false);
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!speechEnabled) {
      activeAudioRef.current?.pause();
      activeAudioRef.current = null;
      activeUtteranceRef.current = null;
      setSpeechSpeaking(false);
      window.speechSynthesis?.cancel();
      return;
    }

    const reply = client.latestAssistantReply;
    const spokenText = reply ? summarizeSignal(reply) : "";
    if (!reply || !spokenText.trim()) {
      return;
    }

    const backendAudioBase64 = payloadText(reply.payload, "audio_base64");
    const backendAudioPending = payloadBool(reply.payload, "backend_audio_pending") === true;
    const speechTurnId = payloadText(reply.payload, "speech_turn_id");
    const speechDelivery = payloadText(reply.payload, "speech_delivery");
    const replyId = [
      speechTurnId ?? reply.ts,
      reply.type,
      reply.session_id ?? "none",
      speechDelivery ?? "speech",
      backendAudioBase64 ? "backend-audio" : "text",
    ].join(":");
    if (lastSpokenReplyIdRef.current === replyId) {
      return;
    }
    lastSpokenReplyIdRef.current = replyId;

    const stopSpeech = () => {
      activeAudioRef.current?.pause();
      activeAudioRef.current = null;
      activeUtteranceRef.current = null;
      setSpeechSpeaking(false);
      window.speechSynthesis?.cancel();
    };

    const startSpeechPulse = () => {
      setSpeechSpeaking(true);
      setSpeechPulseAt(Date.now());
    };

    const speakWithBrowserVoice = () => {
      if (!("speechSynthesis" in window)) {
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spokenText);
      utterance.rate = 1.03;
      utterance.pitch = 1.06;
      utterance.volume = 1;
      utterance.onstart = () => {
        activeUtteranceRef.current = utterance;
        startSpeechPulse();
      };
      utterance.onboundary = () => {
        if (activeUtteranceRef.current === utterance) {
          setSpeechPulseAt(Date.now());
        }
      };
      utterance.onend = () => {
        if (activeUtteranceRef.current === utterance) {
          activeUtteranceRef.current = null;
          setSpeechSpeaking(false);
        }
      };
      utterance.onerror = () => {
        if (activeUtteranceRef.current === utterance) {
          activeUtteranceRef.current = null;
          setSpeechSpeaking(false);
        }
      };
      window.speechSynthesis.speak(utterance);
    };

    const backendAudioMime = payloadText(reply.payload, "audio_mime_type") ?? "audio/mpeg";
    const backendAudioUrl = backendAudioBase64
      ? `data:${backendAudioMime};base64,${backendAudioBase64}`
      : null;

    stopSpeech();

    if (backendAudioPending && !backendAudioUrl) {
      return;
    }

    if (backendAudioUrl) {
      const audio = new Audio(backendAudioUrl);
      audio.preload = "auto";
      audio.volume = 1;
      audio.onplay = () => {
        activeAudioRef.current = audio;
        startSpeechPulse();
      };
      audio.ontimeupdate = () => {
        if (activeAudioRef.current === audio) {
          setSpeechPulseAt(Date.now());
        }
      };
      audio.onended = () => {
        if (activeAudioRef.current === audio) {
          activeAudioRef.current = null;
          setSpeechSpeaking(false);
        }
      };
      audio.onerror = () => {
        if (activeAudioRef.current === audio) {
          activeAudioRef.current = null;
          setSpeechSpeaking(false);
        }
      };
      void audio.play().catch(() => {
        if (activeAudioRef.current === audio) {
          activeAudioRef.current = null;
        }
        speakWithBrowserVoice();
      });
      return;
    }

    speakWithBrowserVoice();
  }, [client.latestAssistantReply, speechEnabled]);

  useEffect(() => {
    if (!speechSpeaking) {
      return;
    }
    const pulseTimer = window.setInterval(() => {
      setSpeechPulseAt(Date.now());
    }, 120);
    return () => {
      window.clearInterval(pulseTimer);
    };
  }, [speechSpeaking]);

  useEffect(() => {
    const realtime = activeRealtimeVoiceRef.current;
    const latestEvent = client.events[0];
    if (!realtime || !latestEvent) {
      return;
    }
    const latestId = eventId(latestEvent);
    if (realtimeNarrationEventIdsRef.current.has(latestId)) {
      return;
    }
    const narrationText = realtimeHermesNarrationText(latestEvent);
    if (!narrationText) {
      return;
    }
    const normalized = normalizeRealtimeRouteText(narrationText);
    const lastNarration = lastRealtimeNarrationRef.current;
    if (lastNarration?.normalized === normalized && Date.now() - lastNarration.at < 8000) {
      realtimeNarrationEventIdsRef.current.add(latestId);
      return;
    }
    realtimeNarrationEventIdsRef.current.add(latestId);
    if (realtimeNarrationEventIdsRef.current.size > 128) {
      realtimeNarrationEventIdsRef.current = new Set(Array.from(realtimeNarrationEventIdsRef.current).slice(-64));
    }
    lastRealtimeNarrationRef.current = { normalized, at: Date.now() };
    speakRealtimeHermesUpdate(narrationText);
  }, [client.events]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      speakRealtimeIdleBanter();
    }, 4000);
    return () => {
      window.clearInterval(timer);
    };
  }, [client.liveSessions]);

  useEffect(() => {
    if (autoBridgeConnectRef.current || connectionMode !== "bridge" || !BRIDGE_ENABLED) {
      return;
    }
    if (client.isConnected || client.connectionState.mode !== "idle") {
      return;
    }
    autoBridgeConnectRef.current = true;
    window.setTimeout(() => {
      connect();
    }, 150);
  }, [client.connectionState.mode, client.isConnected, connectionMode]);

  useEffect(() => {
    if (!client.isConnected || !pendingHermesCommandRef.current) {
      return;
    }
    const pendingCommand = pendingHermesCommandRef.current;
    pendingHermesCommandRef.current = null;
    if (client.sendHermesCommand(pendingCommand.text, pendingCommand.repoPath)) {
      setHermesPrompt("");
    }
  }, [client.isConnected]);

  useEffect(() => {
    if (!client.isConnected || !pendingVoiceAudioRef.current) {
      return;
    }
    const pendingAudio = pendingVoiceAudioRef.current;
    pendingVoiceAudioRef.current = null;
    client.sendVoiceAudio(pendingAudio.audioBase64, pendingAudio.mimeType, pendingAudio.repoPath);
  }, [client.isConnected]);

  useEffect(() => {
    appLiveContextRef.current = {
      repo_path: repoPath.trim() || client.selectedProjectPath,
      selected_project_path: client.selectedProjectPath,
      connection_mode: connectionMode,
      voice: {
        mic_available: voiceAvailable,
        mic_active: isListening || voiceConnecting,
        realtime_connecting: voiceConnecting,
        speech_enabled: speechEnabled,
        speech_speaking: speechSpeaking,
        realtime_active: Boolean(activeRealtimeVoiceRef.current),
      },
      latest_transcript: latestTranscript,
      hermes_phase: client.hermesPhase,
      headset_prompt: client.headsetPrompt,
      workers: client.workerStats,
      focus_worker: detailSession
        ? {
            title: detailSession.title,
            status: detailSession.status,
            label: detailSession.workerLabel,
            phase: detailSession.workerPhase,
            waiting_on_user: detailSession.waitingOnUser,
            needs_review: detailSession.needsReview,
            pending_question: detailSession.pendingQuestion,
            summary: sessionLeadCopy(detailSession),
            stream_preview: sessionStreamPreview(detailSession),
            screen_rows: detailSession.screenRows,
            screen_columns: detailSession.screenColumns,
          }
        : null,
    };
  }, [
    client.selectedProjectPath,
    client.hermesPhase,
    client.headsetPrompt,
    client.workerStats,
    connectionMode,
    detailSession,
    isListening,
    latestTranscript,
    repoPath,
    speechEnabled,
    speechSpeaking,
    voiceAvailable,
    voiceConnecting,
  ]);

  useEffect(() => {
    if (!client.isConnected) {
      return;
    }
    const sendAppContext = () => {
      client.sendLiveContext("quest-app", appLiveContextRef.current);
    };
    sendAppContext();
    const timer = window.setInterval(sendAppContext, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [client.isConnected]);

  useEffect(() => {
    const paired = client.events.find((event) => event.type === "auth.paired");
    const token = paired ? payloadText(paired.payload, "device_token") : undefined;
    if (!token || token === deviceToken) {
      return;
    }
    try {
      window.localStorage.setItem(DEVICE_TOKEN_KEY, token);
    } catch {
      client.noteStatus("Paired for this session, but the browser could not persist the device token.");
    }
    setDeviceToken(token);
  }, [client.events, deviceToken]);

  useEffect(() => {
    const pending = pendingRealtimeVoiceRef.current;
    if (!client.isConnected || !pending || pending.sent) {
      return;
    }
    pending.sent = true;
    void startRealtimeVoiceConnection(pending.requestId, pending.repoPath);
  }, [client.isConnected]);

  useEffect(() => {
    const pending = pendingRealtimeVoiceRef.current;
    const activeRealtime = activeRealtimeVoiceRef.current;
    const requestId = pending?.requestId ?? activeRealtime?.requestId;
    if (!requestId) {
      return;
    }
    let answerEvent = null as (typeof client.events)[number] | null;
    for (let index = client.events.length - 1; index >= 0; index -= 1) {
      const event = client.events[index];
      if (event.type === "voice.realtime.sdp.answer" && payloadText(event.payload, "request_id") === requestId) {
        answerEvent = event;
        break;
      }
    }
    if (!answerEvent) {
      return;
    }
    const eventKey = `${answerEvent.ts}:${requestId}`;
    if (handledRealtimeSessionEventsRef.current.has(eventKey)) {
      return;
    }
    handledRealtimeSessionEventsRef.current.add(eventKey);
    const error = payloadText(answerEvent.payload, "error");
    if (error) {
      pendingRealtimeVoiceRef.current = null;
      voiceDesiredRef.current = false;
      clearRealtimeReconnectTimer();
      setVoiceConnecting(false);
      setIsListening(false);
      client.noteStatus(`Realtime voice failed: ${error}`);
      return;
    }
    const sdp = payloadText(answerEvent.payload, "sdp");
    if (!sdp) {
      pendingRealtimeVoiceRef.current = null;
      voiceDesiredRef.current = false;
      clearRealtimeReconnectTimer();
      setVoiceConnecting(false);
      setIsListening(false);
      client.noteStatus("Realtime voice failed: no SDP answer was returned.");
      return;
    }
    pendingRealtimeVoiceRef.current = null;
    const realtime = activeRealtimeVoiceRef.current;
    if (!realtime || realtime.requestId !== requestId) {
      client.noteStatus("Realtime voice answer arrived after the session was closed.");
      return;
    }
    const sessionConfig = answerEvent.payload.session;
    if (sessionConfig && typeof sessionConfig === "object" && !Array.isArray(sessionConfig)) {
      realtime.sessionConfig = sessionConfig as Record<string, unknown>;
    }
    void realtime.peerConnection
      .setRemoteDescription({ type: "answer", sdp })
      .then(() => {
        setVoiceConnecting(false);
        setIsListening(true);
        client.noteStatus("Realtime Hermes voice connected.");
      })
      .catch((err: unknown) => {
        voiceDesiredRef.current = false;
        clearRealtimeReconnectTimer();
        stopRealtimeVoicePrompt(
          err instanceof Error
            ? `Could not apply realtime voice answer: ${err.message}`
            : "Could not apply realtime voice answer.",
          { reconnect: false },
        );
      });
  }, [client.events]);

  useEffect(() => {
    if (!client.isConnected || !pendingWorkerOpenRef.current) {
      return;
    }
    const pendingOpen = pendingWorkerOpenRef.current;
    pendingWorkerOpenRef.current = null;
    client.openCodingSession(pendingOpen.tool, pendingOpen.repoPath, {
      dangerouslySkipPermissions: pendingOpen.dangerouslySkipPermissions,
    });
  }, [client.isConnected]);

  function connect() {
    if (connectionMode === "bridge" && !BRIDGE_ENABLED) {
      client.noteStatus("Bridge mode is disabled in this build. Switch to direct and enter your Mac host.");
      return;
    }
    if (connectionMode === "bridge") {
      const bridgeScheme = window.location.protocol === "https:" ? "wss" : "ws";
      client.connect({
        url: bridgeTargetUrl,
        scheme: bridgeScheme,
        host: window.location.hostname || "127.0.0.1",
        port: window.location.port ? Number.parseInt(window.location.port, 10) || 443 : 443,
      });
      return;
    }

    if (!host.trim()) {
      client.noteStatus("Enter your Mac host before connecting directly.");
      return;
    }

    client.connect({
      url: directTargetUrl,
      scheme,
      host: host.trim() || "127.0.0.1",
      port: Number.parseInt(port, 10) || 8765,
    });
  }

  function focusWorker(sessionId: string | undefined) {
    if (!sessionId) {
      return;
    }
    setSelectedWorkerId(sessionId);
  }

  function currentRepoPath(): string {
    return repoPath.trim() || client.selectedProjectPath || ".";
  }

  function openWorkerSession(tool: WorkerOpenTool, options: WorkerOpenOptions = {}) {
    const targetRepoPath = currentRepoPath();
    if (!client.isConnected) {
      pendingWorkerOpenRef.current = {
        tool,
        repoPath: targetRepoPath,
        dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      };
      client.noteStatus("Connecting to Hermes, then opening the worker.");
      connect();
      return;
    }
    client.openCodingSession(tool, targetRepoPath, {
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    });
  }

  function sendHermesPrompt() {
    const trimmed = hermesPrompt.trim();
    if (!trimmed) {
      return;
    }
    const targetRepoPath = repoPath.trim() || undefined;
    if (!client.isConnected) {
      pendingHermesCommandRef.current = { text: trimmed, repoPath: targetRepoPath };
      client.noteStatus("Connecting to Hermes, then sending your command.");
      connect();
      return;
    }
    if (client.sendHermesCommand(trimmed, targetRepoPath)) {
      setHermesPrompt("");
    }
  }

  function sendSuggestedPrompt(prompt: string) {
    setHermesPrompt(prompt);
    const targetRepoPath = repoPath.trim() || undefined;
    if (!client.isConnected) {
      pendingHermesCommandRef.current = { text: prompt, repoPath: targetRepoPath };
      client.noteStatus("Connecting to Hermes, then sending your command.");
      connect();
      return;
    }
    client.sendHermesCommand(prompt, targetRepoPath);
  }

  function sendWorkerReply(routeViaManager: boolean) {
    if (!detailSession) {
      return;
    }
    const trimmed = workerReply.trim();
    if (!trimmed) {
      return;
    }
    if (client.sendWorkerReply(detailSession.sessionId, trimmed, routeViaManager)) {
      setWorkerReply("");
    }
  }

  function sendDirectInput() {
    if (!detailSession) {
      return;
    }
    const trimmed = directInput.trim();
    if (!trimmed) {
      return;
    }
    if (client.sendDirectWorkerInput(detailSession.sessionId, trimmed)) {
      setDirectInput("");
    }
  }

  function submitVoiceCommand(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setHermesPrompt(trimmed);
    const targetRepoPath = repoPath.trim() || undefined;
    if (!client.isConnected) {
      pendingHermesCommandRef.current = { text: trimmed, repoPath: targetRepoPath };
      client.noteStatus("Connecting to Hermes, then sending your voice command.");
      connect();
      return;
    }
    client.sendHermesCommand(trimmed, targetRepoPath);
  }

  function clearRealtimeReconnectTimer() {
    if (voiceReconnectTimerRef.current !== null) {
      window.clearTimeout(voiceReconnectTimerRef.current);
      voiceReconnectTimerRef.current = null;
    }
  }

  function nextRealtimeRequestId() {
    return crypto.randomUUID ? crypto.randomUUID() : `realtime_${Date.now()}`;
  }

  function scheduleRealtimeVoiceReconnect(reason: string) {
    if (!voiceDesiredRef.current) {
      return;
    }
    clearRealtimeReconnectTimer();
    const attempt = voiceReconnectAttemptRef.current + 1;
    voiceReconnectAttemptRef.current = attempt;
    if (attempt > 3) {
      voiceDesiredRef.current = false;
      setVoiceConnecting(false);
      setIsListening(false);
      client.noteStatus(`${reason} Realtime voice could not stay connected after ${attempt - 1} reconnects.`);
      return;
    }
    const delayMs = Math.min(4200, 700 + attempt * 650);
    setVoiceConnecting(true);
    setIsListening(true);
    client.noteStatus(`${reason} Reconnecting realtime voice...`);
    voiceReconnectTimerRef.current = window.setTimeout(() => {
      voiceReconnectTimerRef.current = null;
      if (!voiceDesiredRef.current) {
        return;
      }
      const requestId = nextRealtimeRequestId();
      pendingRealtimeVoiceRef.current = {
        requestId,
        repoPath: lastRealtimeRepoPathRef.current,
        sent: true,
      };
      void startRealtimeVoiceConnection(requestId, lastRealtimeRepoPathRef.current);
    }, delayMs);
  }

  function stopVoicePrompt() {
    voiceDesiredRef.current = false;
    clearRealtimeReconnectTimer();
    if (activeRealtimeVoiceRef.current || pendingRealtimeVoiceRef.current) {
      pendingRealtimeVoiceRef.current = null;
      setVoiceConnecting(false);
      stopRealtimeVoicePrompt("Realtime Hermes voice stopped.", { reconnect: false });
      return;
    }

    const recognition = activeRecognitionRef.current;
    activeRecognitionRef.current = null;
    if (recognition) {
      setIsListening(false);
      try {
        recognition.stop();
      } catch {
        // Browser speech engines can throw if stop lands after an implicit end.
      }
      return;
    }

    const recorder = activeMediaRecorderRef.current;
    if (recorder) {
      client.noteStatus("Sending microphone audio to Hermes...");
      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      } catch {
        activeMediaRecorderRef.current = null;
        setIsListening(false);
        client.noteStatus("Could not stop microphone recording.");
      }
    }
  }

  function stopRealtimeVoicePrompt(
    message = "Realtime Hermes voice stopped.",
    options: { reconnect?: boolean } = {},
  ) {
    const realtime = activeRealtimeVoiceRef.current;
    activeRealtimeVoiceRef.current = null;
    handledRealtimeFunctionCallsRef.current.clear();
    realtimeResponseInProgressRef.current = false;
    pendingRealtimeFunctionResponseRef.current = false;
    realtimeNarrationEventIdsRef.current.clear();
    lastRealtimeNarrationRef.current = null;
    queuedRealtimeNarrationRef.current = null;
    lastRealtimeVoiceActivityAtRef.current = 0;
    lastRealtimeIdleBanterAtRef.current = 0;
    if (realtimeNarrationTimerRef.current !== null) {
      window.clearTimeout(realtimeNarrationTimerRef.current);
      realtimeNarrationTimerRef.current = null;
    }
    setVoiceConnecting(false);
    if (realtime) {
      try {
        realtime.dataChannel.close();
      } catch {
        // Data channels may already be closed after a failed negotiation.
      }
      realtime.peerConnection.close();
      realtime.mediaStream.getTracks().forEach((track) => track.stop());
      realtime.audioElement.srcObject = null;
      realtime.audioElement.remove();
    }
    setIsListening(false);
    setSpeechSpeaking(false);
    client.noteStatus(message);
    if (options.reconnect) {
      scheduleRealtimeVoiceReconnect(message);
    }
  }

  function routeRealtimeTextToHermes(text: string, source: "transcript" | "tool"): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    const normalized = normalizeRealtimeRouteText(trimmed);
    const lastRoute = lastRealtimeHermesRouteRef.current;
    if (lastRoute?.normalized === normalized && Date.now() - lastRoute.at < 7000) {
      return true;
    }
    const targetRepoPath = repoPath.trim() || undefined;
    const sent = client.sendHermesCommand(trimmed, targetRepoPath);
    if (sent) {
      lastRealtimeHermesRouteRef.current = { normalized, at: Date.now() };
      client.noteStatus(
        source === "tool"
          ? "Realtime voice routed tool call to local Hermes."
          : "Realtime voice routed command to local Hermes.",
      );
    }
    return sent;
  }

  function createRealtimeVoiceResponse(instructions?: string) {
    const realtime = activeRealtimeVoiceRef.current;
    if (!realtime || realtime.dataChannel.readyState !== "open") {
      return;
    }
    if (realtimeResponseInProgressRef.current) {
      if (!instructions) {
        pendingRealtimeFunctionResponseRef.current = true;
      }
      return;
    }
    realtimeResponseInProgressRef.current = true;
    lastRealtimeVoiceActivityAtRef.current = Date.now();
    realtime.dataChannel.send(
      JSON.stringify({
        type: "response.create",
        ...(instructions
          ? {
              response: {
                output_modalities: ["audio"],
                instructions,
              },
            }
          : {}),
      }),
    );
  }

  function flushPendingRealtimeFunctionResponse() {
    if (!pendingRealtimeFunctionResponseRef.current || realtimeResponseInProgressRef.current) {
      return false;
    }
    pendingRealtimeFunctionResponseRef.current = false;
    createRealtimeVoiceResponse();
    return true;
  }

  function addRealtimeConversationText(text: string) {
    const realtime = activeRealtimeVoiceRef.current;
    if (!realtime || realtime.dataChannel.readyState !== "open") {
      return false;
    }
    realtime.dataChannel.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text,
            },
          ],
        },
      }),
    );
    return true;
  }

  function flushQueuedRealtimeNarration() {
    if (realtimeResponseInProgressRef.current) {
      return;
    }
    const queued = queuedRealtimeNarrationRef.current;
    if (!queued) {
      return;
    }
    queuedRealtimeNarrationRef.current = null;
    if (!addRealtimeConversationText(queued.text)) {
      return;
    }
    createRealtimeVoiceResponse(queued.instructions);
  }

  function queueRealtimeNarrationFlush() {
    if (realtimeNarrationTimerRef.current !== null) {
      window.clearTimeout(realtimeNarrationTimerRef.current);
    }
    realtimeNarrationTimerRef.current = window.setTimeout(() => {
      realtimeNarrationTimerRef.current = null;
      flushQueuedRealtimeNarration();
    }, 900);
  }

  function speakRealtimeHermesUpdate(updateText: string) {
    const trimmed = updateText.trim();
    if (!trimmed || !activeRealtimeVoiceRef.current) {
      return;
    }
    const clipped = trimmed.length > 360 ? `${trimmed.slice(0, 360).trimEnd()}...` : trimmed;
    const narration = {
      text: `[Hermes backend update]\n${clipped}`,
      instructions: [
        "This is a real backend update from the local Hermes supervisor or one of its coding workers.",
        "Do not call route_to_hermes for this backend update.",
        "Speak as Hermy in first person and give the user the actual progress.",
        "Keep it to one or two short sentences.",
        "Stay sassy, bratty, and useful; a tiny playful check-in or roast is fine when the work is not failing.",
        "Do not claim the coding work is finished unless the backend update says it finished.",
      ].join(" "),
    };
    if (realtimeResponseInProgressRef.current) {
      queuedRealtimeNarrationRef.current = narration;
      queueRealtimeNarrationFlush();
      return;
    }
    queuedRealtimeNarrationRef.current = null;
    if (!addRealtimeConversationText(narration.text)) {
      return;
    }
    createRealtimeVoiceResponse(narration.instructions);
  }

  function speakRealtimeIdleBanter() {
    const realtime = activeRealtimeVoiceRef.current;
    if (!realtime || realtime.dataChannel.readyState !== "open" || realtimeResponseInProgressRef.current) {
      return;
    }
    const liveSessions = client.liveSessions;
    if (liveSessions.length === 0) {
      return;
    }
    const now = Date.now();
    const lastVoiceAt = Math.max(
      lastRealtimeVoiceActivityAtRef.current,
      lastRealtimeIdleBanterAtRef.current,
      lastRealtimeNarrationRef.current?.at ?? 0,
    );
    if (now - lastVoiceAt < 14000) {
      return;
    }
    const lead = liveSessions[0];
    const workerContext = liveSessions
      .slice(0, 3)
      .map((session) => {
        const preview = sessionStreamPreview(session) ?? session.lastUpdate ?? session.managerSummary ?? session.taskTitle;
        return `${session.workerLabel ?? session.title}: ${session.status}${session.workerPhase ? `/${session.workerPhase}` : ""}${preview ? ` - ${preview.slice(0, 180)}` : ""}`;
      })
      .join("\n");
    if (!addRealtimeConversationText(`[Hermes idle banter while workers run]\n${workerContext}`)) {
      return;
    }
    lastRealtimeIdleBanterAtRef.current = now;
    createRealtimeVoiceResponse(
      [
        "The local Hermes backend is still working. Keep the conversation alive while the user waits.",
        "Do not call route_to_hermes for this idle banter.",
        `Primary worker: ${lead.workerLabel ?? lead.title}.`,
        "Say one or two short sentences only.",
        "Be roasty, bratty, and playfully mean. A random tiny check-in joke about hydration, showering, laundry, or posture is allowed.",
        "Do not invent real reminders, do not claim the work is finished, and do not be cruel or hateful. Keep it useful enough to mention that the worker is still running.",
      ].join(" "),
    );
  }

  function acknowledgeRealtimeHermesRoute(transcript: string, sent: boolean) {
    const clippedTranscript =
      transcript.length > 220 ? `${transcript.slice(0, 220).trimEnd()}...` : transcript;
    createRealtimeVoiceResponse(
      sent
        ? [
            "The app already routed the user's latest command to the local Hermes supervisor.",
            `User command: ${JSON.stringify(clippedTranscript)}.`,
            "Do not call route_to_hermes again for this acknowledgement.",
            "Speak as Hermy in first person. Keep it under two short sentences.",
            "Be sassy, bratty, and useful. Say the worker/session/panels will show progress. You may add one tiny playful check-in or roast if it fits, but do not invent a reminder. Do not claim the coding work is finished yet.",
          ].join(" ")
        : [
            "The app tried to route the user's latest command to the local Hermes supervisor but the bridge was not connected.",
            "Tell the user briefly that Hermes did not receive it and they need the Mac companion connection back.",
          ].join(" "),
    );
  }

  function handleRealtimeDataChannelEvent(rawData: string) {
    let serverEvent: unknown;
    try {
      serverEvent = JSON.parse(rawData);
    } catch {
      return;
    }
    if (!serverEvent || typeof serverEvent !== "object") {
      return;
    }
    const eventRecord = serverEvent as Record<string, unknown>;
    const type = typeof eventRecord.type === "string" ? eventRecord.type : "";
    if (type === "input_audio_buffer.speech_started") {
      lastRealtimeVoiceActivityAtRef.current = Date.now();
      activeAudioRef.current?.pause();
      activeAudioRef.current = null;
      window.speechSynthesis?.cancel();
      setIsListening(true);
      setSpeechSpeaking(false);
      client.noteStatus("Realtime Hermes is listening...");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      lastRealtimeVoiceActivityAtRef.current = Date.now();
      client.noteStatus("Realtime Hermes heard you.");
      return;
    }
    if (type === "response.created") {
      realtimeResponseInProgressRef.current = true;
      lastRealtimeVoiceActivityAtRef.current = Date.now();
      setSpeechSpeaking(true);
      setSpeechPulseAt(Date.now());
      return;
    }
    if (type === "response.output_audio.delta") {
      lastRealtimeVoiceActivityAtRef.current = Date.now();
      setSpeechSpeaking(true);
      setSpeechPulseAt(Date.now());
      return;
    }
    if (type === "response.output_audio_transcript.delta") {
      setSpeechPulseAt(Date.now());
      return;
    }
    if (type.endsWith("input_audio_transcription.completed")) {
      const transcript = typeof eventRecord.transcript === "string" ? eventRecord.transcript.trim() : "";
      if (transcript) {
        client.sendLiveContext("quest-realtime-transcript", {
          latest_transcript: transcript,
          realtime_active: true,
          routed_to_hermes: shouldRouteRealtimeTranscriptToHermes(transcript),
          captured_at: new Date().toISOString(),
        });
      }
      if (transcript && shouldRouteRealtimeTranscriptToHermes(transcript)) {
        const sent = routeRealtimeTextToHermes(transcript, "transcript");
        acknowledgeRealtimeHermesRoute(transcript, sent);
      } else if (transcript) {
        createRealtimeVoiceResponse();
      }
      return;
    }
    if (type === "response.function_call_arguments.done") {
      const name = typeof eventRecord.name === "string" ? eventRecord.name : "";
      const callId = typeof eventRecord.call_id === "string" ? eventRecord.call_id : "";
      const rawArguments = typeof eventRecord.arguments === "string" ? eventRecord.arguments : "{}";
      handleRealtimeFunctionCall(name, callId, rawArguments);
      return;
    }
    if (type === "response.done") {
      realtimeResponseInProgressRef.current = false;
      lastRealtimeVoiceActivityAtRef.current = Date.now();
      setSpeechSpeaking(false);
      handleRealtimeFunctionCalls(eventRecord);
      if (flushPendingRealtimeFunctionResponse()) {
        return;
      }
      flushQueuedRealtimeNarration();
      return;
    }
    if (type === "error") {
      realtimeResponseInProgressRef.current = false;
      setSpeechSpeaking(false);
      const error = eventRecord.error;
      const message =
        error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
          ? String((error as Record<string, unknown>).message)
          : "Realtime voice error.";
      client.noteStatus(message);
      if (flushPendingRealtimeFunctionResponse()) {
        return;
      }
      flushQueuedRealtimeNarration();
    }
  }

  function realtimeRouteTextFromArguments(rawArguments: string): string {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
        return parsed.text.trim();
      }
    } catch {
      // Some interrupted/incomplete function-call events can contain partial text.
    }
    return rawArguments.trim();
  }

  function handleRealtimeFunctionCall(name: string, callId: string, rawArguments: string) {
    const realtime = activeRealtimeVoiceRef.current;
    if (!realtime || name !== "route_to_hermes") {
      return;
    }
    const functionCallKey = callId || `${name}:${rawArguments}`;
    if (handledRealtimeFunctionCallsRef.current.has(functionCallKey)) {
      return;
    }
    handledRealtimeFunctionCallsRef.current.add(functionCallKey);
    const routedText = realtimeRouteTextFromArguments(rawArguments);
    const sent = routedText ? routeRealtimeTextToHermes(routedText, "tool") : false;
    if (callId && realtime.dataChannel.readyState === "open") {
      realtime.dataChannel.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              ok: sent,
              routed_text: routedText,
              message: sent
                ? "Hermes accepted the command and is opening or updating the worker/session now. Acknowledge as Hermy in first person with a short sassy line. Do not claim the coding work is finished yet."
                : "Could not route to the local Hermes supervisor.",
            }),
          },
        }),
      );
      if (realtimeResponseInProgressRef.current) {
        pendingRealtimeFunctionResponseRef.current = true;
      } else {
        createRealtimeVoiceResponse();
      }
    }
  }

  function handleRealtimeFunctionCalls(serverEvent: Record<string, unknown>) {
    const response = serverEvent.response;
    if (!response || typeof response !== "object") {
      return;
    }
    const output = (response as Record<string, unknown>).output;
    if (!Array.isArray(output)) {
      return;
    }
    output.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const record = item as Record<string, unknown>;
      if (record.type !== "function_call" || record.name !== "route_to_hermes") {
        return;
      }
      const callId = typeof record.call_id === "string" ? record.call_id : "";
      const rawArguments = typeof record.arguments === "string" ? record.arguments : "{}";
      handleRealtimeFunctionCall(String(record.name), callId, rawArguments);
    });
  }

  function waitForIceGatheringComplete(peerConnection: RTCPeerConnection): Promise<void> {
    if (peerConnection.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        peerConnection.removeEventListener("icegatheringstatechange", handleStateChange);
        resolve();
      }, 1800);
      const handleStateChange = () => {
        if (peerConnection.iceGatheringState !== "complete") {
          return;
        }
        window.clearTimeout(timeout);
        peerConnection.removeEventListener("icegatheringstatechange", handleStateChange);
        resolve();
      };
      peerConnection.addEventListener("icegatheringstatechange", handleStateChange);
    });
  }

  async function startRealtimeVoiceConnection(requestId: string, requestRepoPath?: string) {
    if (!canAccessMicrophone()) {
      client.noteStatus(`Realtime voice needs the secure HTTPS ${phoneBodyLaunch ? "phone XR body URL" : "Quest URL"}.`);
      setVoiceConnecting(false);
      setIsListening(false);
      return;
    }
    if (!("RTCPeerConnection" in window)) {
      client.noteStatus("Realtime voice needs WebRTC support in this browser.");
      setVoiceConnecting(false);
      setIsListening(false);
      return;
    }

    setSpeechEnabled(false);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const peerConnection = new RTCPeerConnection();
      peerConnection.addEventListener("connectionstatechange", () => {
        const state = peerConnection.connectionState;
        if (state === "connected") {
          voiceReconnectAttemptRef.current = 0;
          client.noteStatus("Realtime Hermes voice transport connected.");
          return;
        }
        if (state === "failed" || state === "disconnected") {
          client.noteStatus(`Realtime voice transport ${state}.`);
          if (state === "failed" && activeRealtimeVoiceRef.current?.peerConnection === peerConnection) {
            stopRealtimeVoicePrompt("Realtime voice transport failed.", { reconnect: voiceDesiredRef.current });
          }
        }
      });
      const audioElement = document.createElement("audio");
      audioElement.autoplay = true;
      audioElement.setAttribute("playsinline", "true");
      audioElement.style.display = "none";
      document.body.appendChild(audioElement);
      peerConnection.ontrack = (event) => {
        audioElement.srcObject = event.streams[0] ?? null;
        void audioElement.play().catch(() => {
          client.noteStatus("Realtime voice connected, but Quest blocked audio playback. Tap mic again.");
        });
      };
      mediaStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, mediaStream);
      });

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannel.addEventListener("open", () => {
        voiceReconnectAttemptRef.current = 0;
        realtimeResponseInProgressRef.current = false;
        pendingRealtimeFunctionResponseRef.current = false;
        const realtime = activeRealtimeVoiceRef.current;
        if (realtime?.dataChannel === dataChannel && realtime.sessionConfig) {
          dataChannel.send(JSON.stringify({ type: "session.update", session: realtime.sessionConfig }));
        }
        lastRealtimeVoiceActivityAtRef.current = Date.now();
        lastRealtimeIdleBanterAtRef.current = Date.now();
        setVoiceConnecting(false);
        setIsListening(true);
        client.noteStatus("Realtime Hermes is live. Just talk.");
      });
      dataChannel.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          handleRealtimeDataChannelEvent(event.data);
        }
      });
      dataChannel.addEventListener("close", () => {
        if (activeRealtimeVoiceRef.current?.dataChannel === dataChannel) {
          stopRealtimeVoicePrompt("Realtime Hermes voice disconnected.", { reconnect: voiceDesiredRef.current });
        }
      });

      activeRealtimeVoiceRef.current = {
        requestId,
        peerConnection,
        dataChannel,
        mediaStream,
        audioElement,
      };
      handledRealtimeFunctionCallsRef.current.clear();

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await waitForIceGatheringComplete(peerConnection);
      const localSdp = peerConnection.localDescription?.sdp ?? offer.sdp ?? "";
      if (!localSdp.trim()) {
        throw new Error("Browser did not create a realtime voice SDP offer.");
      }
      if (!client.sendRealtimeVoiceOffer(requestId, localSdp, requestRepoPath)) {
        throw new Error("Could not send realtime voice offer to the Mac companion.");
      }
      client.noteStatus("Realtime Hermes voice offer sent. Waiting for answer...");
    } catch (error) {
      setVoiceConnecting(false);
      const shouldReconnect = voiceDesiredRef.current && activeRealtimeVoiceRef.current !== null;
      stopRealtimeVoicePrompt(
        error instanceof Error
          ? `Could not start realtime Hermes voice: ${error.message}`
          : "Could not start realtime Hermes voice.",
        { reconnect: shouldReconnect },
      );
    }
  }

  function startRealtimeVoicePrompt() {
    if (!canAccessMicrophone()) {
      voiceDesiredRef.current = false;
      client.noteStatus(`Realtime voice needs the secure HTTPS ${phoneBodyLaunch ? "phone XR body URL" : "Quest URL"}.`);
      setVoiceConnecting(false);
      setIsListening(false);
      return;
    }
    if (!canStartRealtimeVoice()) {
      voiceDesiredRef.current = false;
      client.noteStatus("Realtime voice needs WebRTC support in this browser.");
      setVoiceConnecting(false);
      setIsListening(false);
      return;
    }
    const targetRepoPath = repoPath.trim() || undefined;
    const requestId = nextRealtimeRequestId();
    voiceDesiredRef.current = true;
    voiceReconnectAttemptRef.current = 0;
    clearRealtimeReconnectTimer();
    lastRealtimeRepoPathRef.current = targetRepoPath;
    pendingRealtimeVoiceRef.current = {
      requestId,
      repoPath: targetRepoPath,
      sent: false,
    };
    setSpeechEnabled(false);
    setVoiceConnecting(true);
    setIsListening(true);
    client.noteStatus("Starting realtime Hermes voice...");
    if (!client.isConnected) {
      connect();
      return;
    }
    pendingRealtimeVoiceRef.current.sent = true;
    void startRealtimeVoiceConnection(requestId, targetRepoPath);
  }

  function clearRecordedVoicePrompt() {
    activeMediaRecorderRef.current = null;
    mediaRecorderChunksRef.current = [];
    activeMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    activeMediaStreamRef.current = null;
    setIsListening(false);
  }

  async function sendRecordedVoicePrompt(mimeType: string) {
    const chunks = mediaRecorderChunksRef.current;
    const fallbackMimeType = mimeType || "audio/webm";
    activeMediaRecorderRef.current = null;
    activeMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    activeMediaStreamRef.current = null;
    mediaRecorderChunksRef.current = [];
    setIsListening(false);

    if (!chunks.length) {
      client.noteStatus("I did not receive audio from the microphone.");
      return;
    }

    const blob = new Blob(chunks, { type: fallbackMimeType });
    if (blob.size < 128) {
      client.noteStatus("I did not receive enough microphone audio.");
      return;
    }

    try {
      const audioBase64 = await blobToBase64(blob);
      const targetRepoPath = repoPath.trim() || undefined;
      const payload = {
        audioBase64,
        mimeType: blob.type || fallbackMimeType,
        repoPath: targetRepoPath,
      };
      if (!client.isConnected) {
        pendingVoiceAudioRef.current = payload;
        client.noteStatus("Connecting to Hermes, then sending your mic recording.");
        connect();
        return;
      }
      client.sendVoiceAudio(payload.audioBase64, payload.mimeType, payload.repoPath);
    } catch (error) {
      client.noteStatus(
        error instanceof Error
          ? `Could not send microphone audio: ${error.message}`
          : "Could not send microphone audio.",
      );
    }
  }

  async function startRecordedVoicePrompt() {
    if (!canCaptureMicrophone()) {
      client.noteStatus(`Microphone capture needs the secure HTTPS ${phoneBodyLaunch ? "phone XR body URL" : "Quest URL"}.`);
      return;
    }
    if (activeMediaRecorderRef.current) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const requestedMimeType = preferredVoiceMimeType();
      const recorder = new MediaRecorder(
        stream,
        requestedMimeType ? { mimeType: requestedMimeType } : undefined,
      );
      mediaRecorderChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          mediaRecorderChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        clearRecordedVoicePrompt();
        client.noteStatus("Microphone recording failed.");
      };
      recorder.onstop = () => {
        void sendRecordedVoicePrompt(recorder.mimeType || requestedMimeType || "audio/webm");
      };
      activeMediaStreamRef.current = stream;
      activeMediaRecorderRef.current = recorder;
      recorder.start();
      setIsListening(true);
      client.noteStatus("Mic is recording. Tap again to send.");
    } catch (error) {
      clearRecordedVoicePrompt();
      client.noteStatus(
        error instanceof Error
          ? `Could not start microphone capture: ${error.message}`
          : "Could not start microphone capture.",
      );
    }
  }

  function startVoicePrompt() {
    const recognizerClass = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!recognizerClass) {
      void startRecordedVoicePrompt();
      return;
    }
    if (activeRecognitionRef.current) {
      return;
    }
    const recognition = new recognizerClass();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const nextText = Array.from(event.results)
        .slice(event.resultIndex ?? 0)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (nextText) {
        submitVoiceCommand(nextText);
      }
    };
    recognition.onerror = () => {
      setIsListening(false);
      activeRecognitionRef.current = null;
    };
    recognition.onend = () => {
      setIsListening(false);
      activeRecognitionRef.current = null;
    };
    activeRecognitionRef.current = recognition;
    setIsListening(true);
    try {
      recognition.start();
    } catch (error) {
      activeRecognitionRef.current = null;
      setIsListening(false);
      client.noteStatus(
        error instanceof Error
          ? `Could not start microphone recognition: ${error.message}`
          : "Could not start microphone recognition.",
      );
    }
  }

  function toggleVoicePrompt() {
    if (
      isListening ||
      activeRealtimeVoiceRef.current ||
      pendingRealtimeVoiceRef.current ||
      activeRecognitionRef.current ||
      activeMediaRecorderRef.current
    ) {
      stopVoicePrompt();
      return;
    }
    startRealtimeVoicePrompt();
  }

  voiceToggleRequestRef.current = toggleVoicePrompt;

  useEffect(() => {
    const handleXrVoiceToggle = (event: Event) => {
      event.preventDefault();
      voiceToggleRequestRef.current();
    };
    window.addEventListener(XR_VOICE_TOGGLE_EVENT, handleXrVoiceToggle);
    return () => {
      window.removeEventListener(XR_VOICE_TOGGLE_EVENT, handleXrVoiceToggle);
    };
  }, []);

  return (
    <main className="app-shell control-deck">
      <section className="deck-panel deck-header">
        <div className="deck-brand">
          <span className="deck-mark">H</span>
          <div>
            <p className="eyebrow">Hermes OS <span className="deck-version">v2.1.3</span></p>
            <strong>AI Orchestration System</strong>
          </div>
        </div>

        <div className="mode-bank" aria-label="Hermes mode">
          {(["listening", "thinking", "working", "blocked", "ready"] as const).map((mode) => {
            const isBlocked = client.pendingSession || client.attentionSessions.some((session) => session.workerPhase === "blocked");
            const active =
              mode === "listening"
                ? isListening || client.avatarState.mode === "listening" || client.avatarState.mode === "speaking"
                : mode === "thinking"
                  ? client.avatarState.mode === "thinking"
                  : mode === "working"
                    ? client.hermesPhase.tone === "working"
                    : mode === "blocked"
                      ? Boolean(isBlocked)
                      : client.hermesPhase.tone === "success" || client.hermesPhase.tone === "calm";
            return (
              <span key={mode} className={`mode-line ${active ? "is-active" : ""} mode-${mode}`}>
                <i />
                {mode}
              </span>
            );
          })}
        </div>

        <div className={`deck-state-card ${toneClass(client.hermesPhase.tone)}`}>
          <p className="eyebrow">Hermes State</p>
          <strong>{client.hermesPhase.title}</strong>
          <small>{client.hermesPhase.subtitle}</small>
          <span>{client.workerStats.live} live worker{client.workerStats.live === 1 ? "" : "s"}</span>
        </div>

        <div className="deck-connection">
          <p className="eyebrow">Connection</p>
          <strong>{bodyDeviceLabel} <span>↔</span> Mac</strong>
          <small>{compactConnectionStatus}</small>
        </div>

        <div className="deck-header-controls">
          <button className="header-control-button" onClick={connect}>
            {client.isConnected ? "Reconnect" : "Connect"}
          </button>
          <button className="header-control-button" onClick={() => client.disconnect()}>
            Disconnect
          </button>
        </div>

        <button
          type="button"
          className="deck-xr-pill"
          onClick={() => {
            const directEnterXR = window.__xrAgentEnterXR;
            if (typeof directEnterXR === "function") {
              directEnterXR();
              return;
            }
            setXrEntryStatus({
              state: "checking",
              label: "Checking XR...",
              summary: "Stage loading",
              message: "Yuki stage is still loading. Try again once the stage card appears.",
              canRequest: false,
            });
            window.dispatchEvent(new Event("xr-agent-enter-xr"));
          }}
        >
          <span>{xrDeckLabel}</span>
          <small>{xrDeckSummary}</small>
        </button>

        <div className="deck-code">
          <strong>02</strong>
          <small>HS-02</small>
        </div>

        <label className="deck-project">
          <span>Project</span>
          <input
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            placeholder={phoneBodyLaunch ? "~/work/xr-coding-agent" : "~/work/MetaQuest"}
          />
        </label>
      </section>

      <section className="deck-grid">
        <aside className="deck-panel signal-deck">
          <header className="panel-header compact">
            <div>
              <p className="eyebrow">Signal Feed</p>
              <h2>Live events</h2>
            </div>
            <button className="mini-button" onClick={() => client.requestSessionSync()}>
              Sync
            </button>
          </header>

          <div className="feed-list scroll-surface deck-feed">
            {client.signalEvents.length === 0 ? (
              <div className="empty-state">No events yet.</div>
            ) : (
              client.signalEvents.slice(0, 10).map((event) => (
                <article key={`${event.ts}-${event.type}-${event.session_id ?? "none"}`} className="feed-item deck-feed-item">
                  <time>{formatEventTime(event.ts)}</time>
                  <strong>{signalLabel(event)}</strong>
                  <p>{summarizeSignal(event)}</p>
                </article>
              ))
            )}
          </div>

          <div className="deck-mini-status">
            <div>
              <span>Workers</span>
              <strong>{client.workerStats.live}</strong>
            </div>
            <div>
              <span>Signals</span>
              <strong>{client.signalEvents.length}</strong>
            </div>
            <div>
              <span>State</span>
              <strong>{miniConnectionStatus}</strong>
            </div>
          </div>
        </aside>

        <section className="deck-center">
          <Suspense
            fallback={
              <div className="presence-stage stage-fallback">
                <div className="summary-card">
                  <p className="summary-title">Loading Yuki stage</p>
                  <p className="summary-body">Avatar runtime starting.</p>
                </div>
              </div>
            }
          >
            <ImmersiveHermesStage
              characterState={characterState}
              avatarMode={client.avatarState.mode}
              tone={client.hermesPhase.tone}
              title={client.hermesPhase.title}
              subtitle={client.hermesPhase.subtitle}
              speechPulseAt={speechPulseAt}
              speechSpeaking={speechSpeaking}
              latestTranscript={latestTranscript}
              signalEvents={client.signalEvents}
              activityEvents={client.events}
              micAvailable={voiceAvailable || canAccessMicrophone()}
              micActive={isListening || voiceConnecting}
              onToggleMic={toggleVoicePrompt}
              onLiveContext={client.sendLiveContext}
              leadSession={detailSession}
              sessions={client.liveSessions}
              latestSummary={
                client.latestHermesUpdate
                  ? summarizeSignal(client.latestHermesUpdate)
                  : "Hermes is ready."
              }
            />
          </Suspense>

          <section className="deck-panel voice-console">
            <button
              className={`voice-orb ${isListening || voiceConnecting ? "is-listening" : ""}`}
              onClick={toggleVoicePrompt}
              title={voiceAvailable || canAccessMicrophone() ? "Toggle microphone" : `Microphone capture needs the secure HTTPS ${phoneBodyLaunch ? "phone XR body URL" : "Quest URL"}`}
            >
              <span>{isListening || voiceConnecting ? "Live" : "Mic"}</span>
            </button>
            <div className="voice-monitor">
              <div className="waveform" aria-hidden="true">
                {Array.from({ length: 42 }, (_, index) => (
                  <i key={index} style={{ "--bar": `${18 + ((index * 17) % 54)}%` } as CSSProperties} />
                ))}
              </div>
              <div className="voice-telemetry">
                <strong>{voiceStatusTitle}</strong>
                <span>{voiceStatusDetail}</span>
              </div>
            </div>
            <label className="command-line">
              <span>&gt;</span>
              <input
                value={hermesPrompt}
                onChange={(event) => setHermesPrompt(event.target.value)}
                placeholder="Input channel open"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    sendHermesPrompt();
                  }
                }}
              />
            </label>
            <button className="primary-button send-button" onClick={sendHermesPrompt}>
              Send
            </button>
          </section>

          <section className={`deck-panel next-action-strip ${nextActionTone}`}>
            <div>
              <p className="eyebrow">What Needs Me</p>
              <strong>{client.headsetPrompt.title}</strong>
            </div>
            <p>{client.headsetPrompt.detail}</p>
            {client.headsetPrompt.sessionId ? (
              <button className="mini-button" onClick={() => focusWorker(client.headsetPrompt.sessionId ?? undefined)}>
                Focus
              </button>
            ) : (
              <button className="mini-button" onClick={() => sendSuggestedPrompt("What needs me next?")}>
                Ask
              </button>
            )}
          </section>
        </section>

        <aside className="deck-panel inspection-deck">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Inspection Bay</p>
              <h2>{sessionLabel(detailSession)}</h2>
            </div>
            {detailSession ? (
              <span className={`phase-pill ${detailSession.waitingOnUser ? "tone-attention" : "tone-working"}`}>
                {sessionStatusCopy(detailSession)}
              </span>
            ) : null}
          </header>

          {detailSession ? (
            <>
              <div className="summary-card">
                <p className="summary-title">Why Hermes surfaced this worker</p>
                <p className="summary-body">{sessionLeadCopy(detailSession)}</p>
              </div>

              <div className="detail-meta">
                <div>
                  <span className="meta-label">Task</span>
                  <strong>{detailSession.taskTitle ?? "Hermes is managing the current task."}</strong>
                </div>
                <div>
                  <span className="meta-label">Project</span>
                  <strong>{detailSession.repoPath ?? "Current project not set"}</strong>
                </div>
                <div>
                  <span className="meta-label">Session</span>
                  <strong>{detailSession.sessionId}</strong>
                </div>
                <div>
                  <span className="meta-label">Intent</span>
                  <strong>{detailSession.intent ?? "Hermes-managed flow"}</strong>
                </div>
              </div>

              <div className="detail-meta">
                <div>
                  <span className="meta-label">Worker phase</span>
                  <strong>{sessionStatusCopy(detailSession)}</strong>
                </div>
                <div>
                  <span className="meta-label">Command</span>
                  <strong>{detailSession.command ?? "Hermes-managed session"}</strong>
                </div>
              </div>

              <div className="summary-card">
                <p className="summary-title">Manager summary</p>
                <p className="summary-body">
                  {detailSession.managerSummary ??
                    detailSession.lastUpdate ??
                    "Hermes is tracking this worker and will highlight the next important state change."}
                </p>
              </div>

              {detailSession.pendingQuestion ? (
                <div className="decision-card">
                  <span className="banner-label">Worker needs you</span>
                  <p>{detailSession.pendingQuestion}</p>
                  <div className="button-row approval-row">
                    <button
                      className="primary-button"
                      onClick={() => client.sendWorkerReply(detailSession.sessionId, "approve", true)}
                    >
                      Execute
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => client.sendWorkerReply(detailSession.sessionId, "not yet", true)}
                    >
                      Abort
                    </button>
                  </div>
                  <div className="chip-row">
                    {quickReplySuggestions.map((suggestion) => (
                      <button key={suggestion} className="chip-button" onClick={() => setWorkerReply(suggestion)}>
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="chip-row">
                <button
                  className="chip-button"
                  onClick={() =>
                    sendSuggestedPrompt(
                      `What is ${detailSession.workerLabel ?? detailSession.title} doing right now?`,
                    )
                  }
                >
                  Ask Hermes about this worker
                </button>
                <button
                  className="chip-button"
                  onClick={() =>
                    sendSuggestedPrompt(
                      `Summarize ${detailSession.workerLabel ?? detailSession.title} and tell me if I need to do anything.`,
                    )
                  }
                >
                  Summarize this worker
                </button>
              </div>

              {detailSession.pendingQuestion ? (
                <>
                  <label className="field">
                    <span>Reply through Hermes</span>
                    <textarea
                      value={workerReply}
                      onChange={(event) => setWorkerReply(event.target.value)}
                      placeholder="Tell Hermes what to send back to this worker."
                      rows={3}
                    />
                  </label>
                  <div className="button-row">
                    <button className="primary-button" onClick={() => sendWorkerReply(true)}>
                      Route Reply via Hermes
                    </button>
                  </div>
                </>
              ) : (
                <div className="quiet-banner">
                  No worker question is pending right now. Use the Hermes panel above for manager-routed follow-ups.
                </div>
              )}

              {detailSession.blockedReason ? (
                <div className="decision-card">
                  <span className="banner-label">Blocked reason</span>
                  <p>{detailSession.blockedReason}</p>
                </div>
              ) : null}

              {detailSignals.length > 0 ? (
                <>
                  <header className="panel-header compact">
                    <div>
                      <p className="eyebrow">Recent context</p>
                      <h2>Signals for this worker</h2>
                    </div>
                  </header>
                  <div className="feed-list">
                    {detailSignals.slice(0, 5).map((event) => (
                      <article key={`${event.ts}-${event.type}-${event.session_id ?? "none"}`} className="feed-item">
                        <div className="feed-item-top">
                          <strong>{signalLabel(event)}</strong>
                          <time>{formatEventTime(event.ts)}</time>
                        </div>
                        <p>{summarizeSignal(event)}</p>
                      </article>
                    ))}
                  </div>
                </>
              ) : null}

              <details className="secondary-surface">
                <summary>Direct worker controls</summary>
                <p className="detail-note">
                  Direct input stays available, but it is intentionally secondary to the Hermes-managed flow.
                </p>
                <label className="field">
                  <span>Send straight to worker</span>
                  <textarea
                    value={directInput}
                    onChange={(event) => setDirectInput(event.target.value)}
                    placeholder="Use this only when you want to step into the raw session."
                    rows={3}
                  />
                </label>
                <div className="button-row">
                  <button className="secondary-button" onClick={sendDirectInput}>
                    Send Directly
                  </button>
                </div>
              </details>

              <div className="terminal-header">
                <span>Live preview</span>
                <span>
                  {detailSession.screenColumns && detailSession.screenRows
                    ? `${detailSession.screenColumns}x${detailSession.screenRows}`
                    : detailSession.screenText
                      ? "Live screen"
                      : "Output tail"}
                </span>
              </div>
              <div className="terminal-surface">
                <pre>
                  {detailSession.screenText ||
                    (detailSession.outputTail.length > 0
                      ? detailSession.outputTail.join("\n")
                      : "Waiting for worker output...")}
                </pre>
              </div>
            </>
          ) : (
            <div className="empty-state">
              No worker selected.
            </div>
          )}
        </aside>

        <section className="deck-panel connection-console">
          <header className="panel-header compact">
            <div>
              <p className="eyebrow">Bridge</p>
              <h2>{bodyDeviceLabel} to Mac</h2>
            </div>
            <span className={`phase-pill ${toneClass(client.hermesPhase.tone)}`}>{compactConnectionStatus}</span>
          </header>
          <div className="field-grid compact-fields">
            <label className="field">
              <span>Mode</span>
              <select
                value={connectionMode}
                onChange={(event) => setConnectionMode(event.target.value as "bridge" | "direct")}
              >
                {BRIDGE_ENABLED ? <option value="bridge">Same-origin bridge</option> : null}
                <option value="direct">Direct socket</option>
              </select>
            </label>
            {connectionMode === "direct" ? (
              <>
                <label className="field">
                  <span>Host</span>
                  <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.25" />
                </label>
                <label className="field">
                  <span>Port</span>
                  <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
                </label>
              </>
            ) : null}
          </div>
          <p className="deck-url">{effectiveTargetUrl}</p>
          {connectionDetail && connectionDetail !== connectionWarning ? (
            <p className="connection-detail">{connectionDetail}</p>
          ) : null}
          {connectionWarning ? <p className="deck-warning">{connectionWarning}</p> : null}
          <div className="button-row compact-row">
            <button className="primary-button" onClick={connect}>
              {client.isConnected ? "Reconnect" : "Connect"}
            </button>
            <button className="secondary-button" onClick={() => client.disconnect()}>
              Disconnect
            </button>
            <button className="secondary-button" onClick={() => client.requestProjectPicker(repoPath.trim() || undefined)}>
              Pick Folder
            </button>
          </div>
        </section>

        <section className="deck-panel worker-channels">
          <header className="panel-header compact">
            <div>
              <p className="eyebrow">Worker Channels</p>
              <h2>{client.liveSessions.length} active</h2>
            </div>
            <div className="panel-actions">
              <button className="mini-button" onClick={mostUsefulAction.action}>
                {mostUsefulAction.label}
              </button>
              <button className="mini-button ghost" onClick={secondaryAction.action}>
                {secondaryAction.label}
              </button>
            </div>
          </header>
          <div className="worker-channel-grid">
            {client.liveSessions.length === 0 ? (
              <div className="worker-slot empty-state">No active workers.</div>
            ) : (
              client.liveSessions.slice(0, 4).map((session, index) => (
                <WorkerCard
                  key={session.sessionId}
                  session={session}
                  index={index}
                  isSelected={session.sessionId === detailSession?.sessionId}
                  onSelect={() => setSelectedWorkerId(session.sessionId)}
                />
              ))
            )}
            {client.liveSessions.length < 4
              ? Array.from({ length: 4 - client.liveSessions.length }, (_, index) => (
                  <div key={`empty-${index}`} className="worker-slot">
                    <strong>{String(client.liveSessions.length + index + 1).padStart(2, "0")}</strong>
                    <span>Worker slot</span>
                  </div>
                ))
              : null}
          </div>
        </section>
      </section>
    </main>
  );
}

function WorkerCard({
  session,
  index,
  isSelected,
  onSelect,
}: {
  session: CodingSessionSnapshot;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`worker-card ${isSelected ? "selected" : ""}`} onClick={onSelect}>
      <div className="worker-card-top">
        <span className="worker-number">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong>{session.workerLabel ?? session.title}</strong>
          <p>{session.taskTitle ?? session.statusText ?? session.command ?? "Working"}</p>
        </div>
        <span className={`phase-pill ${session.waitingOnUser ? "tone-attention" : "tone-working"}`}>
          {session.waitingOnUser ? "Waiting" : session.needsReview ? "Review" : sessionStatusCopy(session)}
        </span>
      </div>
      <p className="worker-summary">
        {session.pendingQuestion ??
          session.blockedReason ??
          session.managerSummary ??
          session.lastUpdate ??
          "Hermes is tracking this worker."}
      </p>
      <p className="worker-summary worker-summary-secondary">
        {session.screenText
          ? session.screenText.split("\n").slice(-2).join(" ").slice(0, 160)
          : session.outputTail.slice(-2).join(" ").slice(0, 160) || "Live preview will show here once the worker emits output."}
      </p>
    </button>
  );
}
