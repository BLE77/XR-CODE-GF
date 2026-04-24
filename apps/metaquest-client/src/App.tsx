import { lazy, Suspense, useEffect, useRef, useState } from "react";
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

const DEFAULT_SCHEME: StoredSettings["scheme"] = window.location.protocol === "https:" ? "wss" : "ws";

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
    : directModeUsesLoopback
    ? "Direct mode is still pointing at localhost. On Quest that means the headset itself, so switch host to your Mac LAN IP."
    : directModeMixedContentRisk
      ? "This page is running over HTTPS while direct mode is set to ws. Browsers can block mixed-content sockets. Use bridge mode or switch direct mode to wss."
      : client.connectionState.lastError;
  const mostUsefulAction =
    client.pendingSession
      ? {
          label: "Focus Pending Decision",
          action: () => focusWorker(client.pendingSession?.sessionId),
        }
      : client.liveSessions.length === 0
        ? {
            label: "Open Claude Here",
            action: () => sendSuggestedPrompt("Open Claude here"),
          }
        : {
            label: "Focus Active Worker",
            action: () => focusWorker(detailSession?.sessionId ?? client.prioritySession?.sessionId),
          };
  const secondaryAction =
    client.liveSessions.length === 0
      ? {
          label: "Open Codex Here",
          action: () => sendSuggestedPrompt("Open Codex here"),
        }
      : {
          label: "What Needs Me Next?",
          action: () => sendSuggestedPrompt("Summarize the active workers and tell me what needs attention."),
        };

  useEffect(() => {
    const recognizerClass = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setVoiceAvailable(Boolean(recognizerClass));
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
      setSpeechSpeaking(false);
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

  function sendHermesPrompt() {
    const trimmed = hermesPrompt.trim();
    if (!trimmed) {
      return;
    }
    if (client.sendHermesCommand(trimmed, repoPath.trim() || undefined)) {
      setHermesPrompt("");
    }
  }

  function sendSuggestedPrompt(prompt: string) {
    setHermesPrompt(prompt);
    client.sendHermesCommand(prompt, repoPath.trim() || undefined);
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

  function startVoicePrompt() {
    const recognizerClass = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!recognizerClass) {
      return;
    }
    const recognition = new recognizerClass();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const nextText = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (nextText) {
        setHermesPrompt(nextText);
        client.sendHermesCommand(nextText, repoPath.trim() || undefined);
      }
    };
    recognition.onerror = () => {
      setIsListening(false);
    };
    recognition.onend = () => {
      setIsListening(false);
    };
    setIsListening(true);
    recognition.start();
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-grid">
          <div>
            <p className="eyebrow">Meta Quest Embodied Preview</p>
            <h1>Hermes stays in front. Worker noise stays under control.</h1>
            <p className="hero-copy">
              Hermes still runs the coding flow from the Mac control plane. The headset now prioritizes a readable
              embodied guide, clearer worker status, and approvals you can act on without squinting through tiny UI.
            </p>
            <div className="hero-bullets">
              <span>Hermes is primary</span>
              <span>Workers are summonable</span>
              <span>Approvals stay manager-routed</span>
            </div>
          </div>

          <Suspense
            fallback={
              <div className="presence-stage stage-fallback">
                <div className="summary-card">
                  <p className="summary-title">Loading Yuki stage</p>
                  <p className="summary-body">
                    Pulling in the avatar and XR runtime without blocking the rest of the coding companion.
                  </p>
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
              leadSession={detailSession}
              sessions={client.liveSessions}
              latestSummary={
                client.latestHermesUpdate
                  ? summarizeSignal(client.latestHermesUpdate)
                  : "Hermes is ready to step into the room when you connect."
              }
            />
          </Suspense>
        </div>

        <div className="hero-stats">
          <div className="stat-card">
            <span className="stat-label">Hermes</span>
            <strong>{client.hermesPhase.title}</strong>
            <span>{client.hermesPhase.subtitle}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Live workers</span>
            <strong>{client.workerStats.live}</strong>
            <span>
              {client.workerStats.attention > 0
                ? `${client.workerStats.attention} worker${client.workerStats.attention === 1 ? "" : "s"} need attention.`
                : "Worker board is synced."}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Signal feed</span>
            <strong>{client.signalEvents.length}</strong>
            <span>Hermes-first updates, raw terminal babysitting second.</span>
          </div>
        </div>
      </section>

      <div className="layout-grid">
        <section className="panel stack-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Connection</p>
              <h2>Quest to Mac</h2>
            </div>
            <span className={`phase-pill ${toneClass(client.hermesPhase.tone)}`}>{client.statusText}</span>
          </header>

          <div className="field-grid">
            <label className="field">
              <span>Connection mode</span>
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
                  <span>Transport</span>
                  <select value={scheme} onChange={(event) => setScheme(event.target.value as "ws" | "wss")}>
                    <option value="ws">ws</option>
                    <option value="wss">wss</option>
                  </select>
                </label>
                <label className="field">
                  <span>Mac host</span>
                  <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.25" />
                </label>
                <label className="field">
                  <span>WebSocket port</span>
                  <input
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    inputMode="numeric"
                    placeholder="8765"
                  />
                </label>
              </>
            ) : null}
          </div>

          <div className="summary-card">
            <p className="summary-title">{connectionGuidanceTitle}</p>
            <p className="summary-body">{effectiveTargetUrl}</p>
            <p className="detail-note">{connectionGuidanceBody}</p>
          </div>

          {connectionWarning ? (
            <div className="decision-card">
              <span className="banner-label">Run reliability note</span>
              <p>{connectionWarning}</p>
            </div>
          ) : null}

          <div className="detail-meta">
            <div>
              <span className="meta-label">Socket state</span>
              <strong>{client.connectionState.mode}</strong>
            </div>
            <div>
              <span className="meta-label">Last connected</span>
              <strong>{client.connectionState.lastConnectedUrl ?? "None yet"}</strong>
            </div>
            <div>
              <span className="meta-label">Event flow</span>
              <strong>{client.connectionState.hasReceivedEvents ? `Last event ${formatTimestamp(client.connectionState.lastEventTs)}` : "Waiting for first event"}</strong>
            </div>
            <div>
              <span className="meta-label">Fastest fallback</span>
              <strong>
                {connectionMode === "bridge"
                  ? "Switch to direct + Mac LAN IP"
                  : BRIDGE_ENABLED
                    ? "Switch to bridge if a proxy is available"
                    : "Stay direct and verify the Mac LAN IP"}
              </strong>
            </div>
          </div>

          <label className="field">
            <span>Current project</span>
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder="/Users/you/project"
            />
          </label>

          <div className="button-row utility-row">
            <button className="primary-button" onClick={connect}>
              {client.isConnected ? "Reconnect" : connectionMode === "bridge" ? "Connect Through Bridge" : "Connect Directly"}
            </button>
            <button className="secondary-button" onClick={() => client.disconnect()}>
              Disconnect
            </button>
            {BRIDGE_ENABLED ? (
              <button
                className="secondary-button"
                onClick={() => {
                  setConnectionMode("bridge");
                  setScheme(DEFAULT_SCHEME);
                }}
              >
                Use Bridge
              </button>
            ) : null}
            <button
              className="secondary-button"
              onClick={() => {
                setConnectionMode("direct");
                setHost(window.location.hostname || "127.0.0.1");
                setScheme(DEFAULT_SCHEME);
              }}
            >
              Use Page Host
            </button>
            <button className="secondary-button" onClick={() => client.requestProjectPicker(repoPath.trim() || undefined)}>
              Pick Folder On Mac
            </button>
            <button className="secondary-button" onClick={() => client.requestSessionSync()}>
              Refresh Workers
            </button>
          </div>

          <header className="panel-header compact">
            <div>
              <p className="eyebrow">Hermes Panel</p>
              <h2>Talk to Hermes</h2>
            </div>
            <span className={`phase-pill ${toneClass(client.hermesPhase.tone)}`}>{client.hermesPhase.title}</span>
          </header>

          <div className="summary-card">
            <p className="summary-title">Headset next step</p>
            <p className="summary-body">{client.headsetPrompt.title}</p>
            <p className="detail-note">{client.headsetPrompt.detail}</p>
          </div>

          <div className="summary-card">
            <p className="summary-title">Latest manager summary</p>
            <p className="summary-body">
              {client.latestHermesUpdate ? summarizeSignal(client.latestHermesUpdate) : "Hermes is ready for the next instruction."}
            </p>
          </div>

          <div className="detail-meta">
            <div>
              <span className="meta-label">Yuki voice loop</span>
              <strong>{speechEnabled ? "Speaking Hermes replies" : "Voice playback muted"}</strong>
            </div>
            <div>
              <span className="meta-label">Avatar state</span>
              <strong>{client.avatarState.mode}</strong>
            </div>
            <div>
              <span className="meta-label">Current project</span>
              <strong>{repoPath.trim() || "Not set yet"}</strong>
            </div>
            <div>
              <span className="meta-label">Focus worker</span>
              <strong>{sessionLabel(client.prioritySession)}</strong>
            </div>
          </div>

          <div className="button-row utility-row">
            <button
              className="secondary-button"
              onClick={() => focusWorker(client.headsetPrompt.sessionId)}
              disabled={!client.headsetPrompt.sessionId}
            >
              Focus Next Step
            </button>
            <button
              className="secondary-button"
              onClick={() => setHermesPrompt("Summarize the active workers and tell me what needs attention.")}
            >
              Prep Worker Summary
            </button>
          </div>

          <div className="button-row action-row">
            <button className="primary-button" onClick={mostUsefulAction.action}>
              {mostUsefulAction.label}
            </button>
            <button className="secondary-button" onClick={secondaryAction.action}>
              {secondaryAction.label}
            </button>
            <button
              className="secondary-button"
              onClick={() => sendSuggestedPrompt("Tell me the single most important next step and who is doing it.")}
            >
              Single Next Step
            </button>
          </div>

          {latestTranscript ? (
            <div className="summary-card">
              <p className="summary-title">Latest transcript</p>
              <p className="summary-body">{latestTranscript}</p>
            </div>
          ) : null}

          {latestAssistantText ? (
            <div className="summary-card">
              <p className="summary-title">What Hermes just said</p>
              <p className="summary-body">{latestAssistantText}</p>
            </div>
          ) : null}

          <label className="field">
            <span>Prompt for Hermes</span>
            <textarea
              value={hermesPrompt}
              onChange={(event) => setHermesPrompt(event.target.value)}
              placeholder="Open Claude in this repo and ask it to investigate the failing auth test."
              rows={4}
            />
          </label>

          <div className="button-row">
            <button className="primary-button" onClick={sendHermesPrompt}>
              Send to Hermes
            </button>
            <button
              className="secondary-button"
              onClick={startVoicePrompt}
              disabled={!voiceAvailable || isListening}
              title={voiceAvailable ? "Experimental browser speech capture" : "Speech recognition is not available in this browser"}
            >
              {isListening ? "Listening..." : voiceAvailable ? "Voice Prompt" : "Voice Unavailable"}
            </button>
            <button className="secondary-button" onClick={() => setSpeechEnabled((current) => !current)}>
              {speechEnabled ? "Mute Yuki Voice" : "Unmute Yuki Voice"}
            </button>
          </div>

          <div className="chip-row">
            {[
              "Open Claude here",
              "Ask Codex to inspect the build failure",
              "What is Claude 1 doing?",
              "Summarize the active workers",
            ].map((prompt) => (
              <button key={prompt} className="chip-button" onClick={() => sendSuggestedPrompt(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        </section>

        <section className="panel stack-panel board-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Hermes Supervisor</p>
              <h2>Worker board</h2>
            </div>
            <span className="panel-meta">
              {client.pendingSession ? "A decision is waiting." : "Managers summaries first, raw controls second."}
            </span>
          </header>

          <div className="summary-card">
            <p className="summary-title">Next headset step</p>
            <p className="summary-body">{client.headsetPrompt.title}</p>
            <p className="detail-note">{client.headsetPrompt.detail}</p>
          </div>

          <div className="button-row compact-row">
            <button
              className="secondary-button"
              onClick={() => focusWorker(client.pendingSession?.sessionId)}
              disabled={!client.pendingSession}
            >
              Focus Pending
            </button>
            <button
              className="secondary-button"
              onClick={() => focusWorker(previousWorker?.sessionId)}
              disabled={!previousWorker}
            >
              Previous Worker
            </button>
            <button
              className="secondary-button"
              onClick={() => focusWorker(nextWorker?.sessionId)}
              disabled={!nextWorker}
            >
              Next Worker
            </button>
          </div>

          {client.pendingSession ? (
            <div className="supervisor-banner">
              <span className="banner-label">Pending decision</span>
              <strong>{client.pendingSession.workerLabel ?? client.pendingSession.title}</strong>
              <p>{client.pendingSession.pendingQuestion ?? client.pendingSession.managerSummary}</p>
            </div>
          ) : (
            <div className="quiet-banner">
              Hermes will surface important worker changes here when Claude or Codex needs attention.
            </div>
          )}

          {client.attentionSessions.length > 0 ? (
            <div className="summary-card">
              <p className="summary-title">Attention queue</p>
              <div className="feed-list">
                {client.attentionSessions.slice(0, 3).map((session) => (
                  <article key={session.sessionId} className="feed-item">
                    <div className="feed-item-top">
                      <strong>{sessionLabel(session)}</strong>
                      <time>{sessionStatusCopy(session)}</time>
                    </div>
                    <p>{sessionLeadCopy(session)}</p>
                    <div className="button-row">
                      <button className="secondary-button" onClick={() => focusWorker(session.sessionId)}>
                        Inspect
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          <div className="worker-list scroll-surface">
            {client.liveSessions.length === 0 ? (
              <div className="empty-state">
                No live workers yet. Ask Hermes to open Claude or Codex and the worker board will populate here.
              </div>
            ) : (
              client.liveSessions.map((session) => (
                <WorkerCard
                  key={session.sessionId}
                  session={session}
                  isSelected={session.sessionId === detailSession?.sessionId}
                  onSelect={() => setSelectedWorkerId(session.sessionId)}
                />
              ))
            )}
          </div>

          <header className="panel-header compact">
            <div>
              <p className="eyebrow">Signal Feed</p>
              <h2>High-signal updates</h2>
            </div>
          </header>

          <div className="feed-list scroll-surface feed-surface">
            {client.signalEvents.length === 0 ? (
              <div className="empty-state">Connect to the Mac companion and Hermes will start surfacing worker signals here.</div>
            ) : (
              client.signalEvents.slice(0, 12).map((event) => (
                <article key={`${event.ts}-${event.type}-${event.session_id ?? "none"}`} className="feed-item">
                  <div className="feed-item-top">
                    <strong>{signalLabel(event)}</strong>
                    <time>{formatEventTime(event.ts)}</time>
                  </div>
                  <p>{summarizeSignal(event)}</p>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="panel detail-panel sticky-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Worker Detail</p>
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
                  <div className="button-row">
                    <button
                      className="primary-button"
                      onClick={() => client.sendWorkerReply(detailSession.sessionId, "approve", true)}
                    >
                      Approve via Hermes
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => client.sendWorkerReply(detailSession.sessionId, "not yet", true)}
                    >
                      Reject via Hermes
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
              Open a worker from Hermes and select it from the worker board to inspect the live session surface here.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function WorkerCard({
  session,
  isSelected,
  onSelect,
}: {
  session: CodingSessionSnapshot;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`worker-card ${isSelected ? "selected" : ""}`} onClick={onSelect}>
      <div className="worker-card-top">
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
