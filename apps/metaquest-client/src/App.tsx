import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuestClient } from "./lib/useQuestClient";
import {
  formatEventTime,
  payloadText,
  signalLabel,
  summarizeSignal,
  type CodingSessionSnapshot,
} from "./lib/protocol";

const ImmersiveHermesStage = lazy(async () => {
  const module = await import("./ImmersiveHermesStage");
  return { default: module.ImmersiveHermesStage };
});

const SETTINGS_KEY = "xr-agent-metaquest-settings";
const SPEECH_KEY = "xr-agent-metaquest-speech-enabled";
const BRIDGE_ENABLED =
  import.meta.env.DEV || String(import.meta.env.VITE_XR_ENABLE_BRIDGE ?? "").toLowerCase() === "true";

type StoredSettings = {
  connectionMode: "bridge" | "direct";
  scheme: "ws" | "wss";
  host: string;
  port: number;
  repoPath: string;
};

type WorkerOpenTool = "claude" | "codex" | "hermes";
type WorkerOpenOptions = {
  dangerouslySkipPermissions?: boolean;
};
type BrowserSpeechRecognition = InstanceType<NonNullable<Window["SpeechRecognition"]>>;

const DEFAULT_SCHEME: StoredSettings["scheme"] = window.location.protocol === "https:" ? "wss" : "ws";

function canCaptureMicrophone(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
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

function sessionLeadCopy(session: CodingSessionSnapshot | undefined): string {
  if (!session) {
    return "Hermes is ready to open a worker when you are.";
  }
  return (
    session.pendingQuestion ??
    session.blockedReason ??
    session.managerSummary ??
    session.lastUpdate ??
    session.taskTitle ??
    "Hermes is tracking this worker."
  );
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
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>("");
  const [hermesPrompt, setHermesPrompt] = useState("");
  const [workerReply, setWorkerReply] = useState("");
  const [directInput, setDirectInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(loadSpeechEnabled);
  const [speechPulseAt, setSpeechPulseAt] = useState(0);
  const [speechSpeaking, setSpeechSpeaking] = useState(false);
  const lastSpokenReplyIdRef = useRef("");
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const activeMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const activeMediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderChunksRef = useRef<BlobPart[]>([]);
  const pendingHermesCommandRef = useRef<{ text: string; repoPath?: string } | null>(null);
  const pendingVoiceAudioRef = useRef<{ audioBase64: string; mimeType: string; repoPath?: string } | null>(null);
  const pendingWorkerOpenRef = useRef<
    { tool: WorkerOpenTool; repoPath: string; dangerouslySkipPermissions?: boolean } | null
  >(null);
  const autoBridgeConnectRef = useRef(false);

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
  const bridgeScheme = window.location.protocol === "https:" ? "wss" : "ws";
  const bridgeTargetUrl = `${bridgeScheme}://${window.location.host}/xr-agent-events`;
  const directTargetUrl = `${scheme}://${host.trim() || "127.0.0.1"}:${Number.parseInt(port, 10) || 8765}`;
  const effectiveTargetUrl = connectionMode === "bridge" ? bridgeTargetUrl : directTargetUrl;
  const directModeUsesLoopback = ["localhost", "127.0.0.1"].includes((host.trim() || "").toLowerCase());
  const directModeMixedContentRisk = connectionMode === "direct" && window.location.protocol === "https:" && scheme === "ws";
  const connectionGuidanceTitle =
    connectionMode === "bridge" ? "Bridge through this page origin" : "Connect directly to the Mac companion";
  const connectionGuidanceBody =
    connectionMode === "bridge"
      ? "Use bridge mode only when this page host is actively proxying /xr-agent-events to Hermes, like Vite dev or an explicit reverse proxy. If bridge mode fails, switch to direct and enter the Mac LAN IP."
      : "Use direct mode when Quest Browser needs to talk straight to the Mac companion. On headset, localhost points at the headset, not your Mac.";
  const connectionWarning = !BRIDGE_ENABLED && connectionMode === "bridge"
    ? "Bridge mode is disabled in this build because this page host is not guaranteed to proxy /xr-agent-events. Use direct mode unless you explicitly enable bridge support."
    : connectionMode === "direct" && directModeUsesLoopback
    ? "Direct mode is still pointing at localhost. On Quest that means the headset itself, so switch host to your Mac LAN IP."
    : directModeMixedContentRisk
      ? "This page is running over HTTPS while direct mode is set to ws. Browsers can block mixed-content sockets. Use bridge mode or switch direct mode to wss."
      : client.connectionState.lastError;
  const compactConnectionStatus = client.isConnected
    ? "Connected"
    : client.connectionState.mode === "connecting"
      ? "Connecting"
      : client.connectionState.mode === "error"
        ? "Bridge issue"
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
          label: "Open Codex Here",
          action: () => openWorkerSession("codex"),
        }
      : {
          label: "What Needs Me Next?",
          action: () => sendSuggestedPrompt("What needs me next across the active workers?"),
        };

  useEffect(() => {
    const recognizerClass = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setVoiceAvailable(Boolean(recognizerClass) || canCaptureMicrophone());
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
    if (!selectedWorkerId || !client.sessions.some((session) => session.sessionId === selectedWorkerId)) {
      setSelectedWorkerId(detailSession.sessionId);
    }
  }, [client.sessions, detailSession, selectedWorkerId]);

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

    const replyId = `${reply.ts}-${reply.type}-${reply.session_id ?? "none"}`;
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

    const backendAudioBase64 = payloadText(reply.payload, "audio_base64");
    const backendAudioMime = payloadText(reply.payload, "audio_mime_type") ?? "audio/mpeg";
    const backendAudioUrl = backendAudioBase64
      ? `data:${backendAudioMime};base64,${backendAudioBase64}`
      : null;

    stopSpeech();

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
        url: `${bridgeScheme}://${window.location.host}/xr-agent-events`,
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

  function stopVoicePrompt() {
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
      client.noteStatus("Microphone capture needs the secure HTTPS Quest URL.");
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
    if (isListening || activeRecognitionRef.current || activeMediaRecorderRef.current) {
      stopVoicePrompt();
      return;
    }
    setSpeechEnabled(true);
    startVoicePrompt();
  }

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
          <strong>Quest <span>↔</span> Mac</strong>
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
            const stageButton = document.querySelector<HTMLButtonElement>(".quest-xr-button:not(:disabled)");
            if (stageButton) {
              stageButton.click();
              return;
            }
            window.dispatchEvent(new Event("xr-agent-enter-xr"));
          }}
        >
          <span>Enter XR</span>
          <small>Immersive mode</small>
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
            placeholder="~/work/MetaQuest"
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
              micAvailable={voiceAvailable}
              micActive={isListening}
              onToggleMic={toggleVoicePrompt}
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
              className={`voice-orb ${isListening ? "is-listening" : ""}`}
              onClick={toggleVoicePrompt}
              disabled={!voiceAvailable}
              title={voiceAvailable ? "Toggle microphone" : "Microphone capture needs the secure HTTPS Quest URL"}
            >
              <span>{isListening ? "Send" : "Mic"}</span>
            </button>
            <div className="waveform" aria-hidden="true">
              {Array.from({ length: 42 }, (_, index) => (
                <i key={index} style={{ "--bar": `${18 + ((index * 17) % 54)}%` } as CSSProperties} />
              ))}
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
              <h2>Quest to Mac</h2>
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
