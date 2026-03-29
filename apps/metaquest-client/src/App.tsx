import { useEffect, useState } from "react";
import { useQuestClient } from "./lib/useQuestClient";
import { formatEventTime, signalLabel, summarizeSignal, type CodingSessionSnapshot } from "./lib/protocol";

const SETTINGS_KEY = "xr-agent-metaquest-settings";

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return {
        host: window.location.hostname || "127.0.0.1",
        port: 8765,
        repoPath: "",
      };
    }
    const parsed = JSON.parse(raw) as { host?: string; port?: number; repoPath?: string };
    return {
      host: parsed.host || window.location.hostname || "127.0.0.1",
      port: parsed.port || 8765,
      repoPath: parsed.repoPath || "",
    };
  } catch {
    return {
      host: window.location.hostname || "127.0.0.1",
      port: 8765,
      repoPath: "",
    };
  }
}

function toneClass(tone: string): string {
  return `tone-${tone}`;
}

export default function App() {
  const client = useQuestClient();
  const initialSettings = loadSettings();
  const [host, setHost] = useState(initialSettings.host);
  const [port, setPort] = useState(String(initialSettings.port));
  const [repoPath, setRepoPath] = useState(initialSettings.repoPath);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>("");
  const [hermesPrompt, setHermesPrompt] = useState("");
  const [workerReply, setWorkerReply] = useState("");
  const [directInput, setDirectInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);

  const detailSession =
    client.sessions.find((session) => session.sessionId === selectedWorkerId) ??
    client.pendingSession ??
    client.liveSessions[0];

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
        port: Number.parseInt(port, 10) || 8765,
        repoPath,
      }),
    );
  }, [host, port, repoPath]);

  function connect() {
    client.connect({
      host: host.trim() || "127.0.0.1",
      port: Number.parseInt(port, 10) || 8765,
    });
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
        <div>
          <p className="eyebrow">Meta Quest MVP</p>
          <h1>Hermes stays central. Workers stay inspectable.</h1>
          <p className="hero-copy">
            This Quest client is a thin frontend on top of the existing Mac companion control plane.
            Hermes remains the manager, Claude and Codex remain managed workers, and the headset stays
            focused on high-signal decisions.
          </p>
        </div>

        <div className="hero-stats">
          <div className="stat-card">
            <span className="stat-label">Hermes</span>
            <strong>{client.hermesPhase.title}</strong>
            <span>{client.hermesPhase.subtitle}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Live workers</span>
            <strong>{client.liveSessions.length}</strong>
            <span>{client.pendingSession ? "A worker is waiting on you." : "Worker board is synced."}</span>
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
          </div>

          <label className="field">
            <span>Current project</span>
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder="/Users/you/project"
            />
          </label>

          <div className="button-row">
            <button className="primary-button" onClick={connect}>
              {client.isConnected ? "Reconnect" : "Connect"}
            </button>
            <button className="secondary-button" onClick={() => client.disconnect()}>
              Disconnect
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
            <p className="summary-title">Latest manager summary</p>
            <p className="summary-body">
              {client.latestHermesUpdate ? summarizeSignal(client.latestHermesUpdate) : "Hermes is ready for the next instruction."}
            </p>
          </div>

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
          </div>

          <div className="chip-row">
            {[
              "Open Claude here",
              "Ask Codex to inspect the build failure",
              "What is Claude 1 doing?",
              "Summarize the active workers",
            ].map((prompt) => (
              <button key={prompt} className="chip-button" onClick={() => setHermesPrompt(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        </section>

        <section className="panel stack-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Hermes Supervisor</p>
              <h2>Worker board</h2>
            </div>
            <span className="panel-meta">
              {client.pendingSession ? "A decision is waiting." : "Managers summaries first, raw controls second."}
            </span>
          </header>

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

          <div className="worker-list">
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

          <div className="feed-list">
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

        <section className="panel detail-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Worker Detail</p>
              <h2>{detailSession?.workerLabel ?? detailSession?.title ?? "Open a worker"}</h2>
            </div>
            {detailSession ? (
              <span className={`phase-pill ${detailSession.waitingOnUser ? "tone-attention" : "tone-working"}`}>
                {detailSession.statusText ?? detailSession.workerPhase ?? detailSession.status}
              </span>
            ) : null}
          </header>

          {detailSession ? (
            <>
              <div className="detail-meta">
                <div>
                  <span className="meta-label">Task</span>
                  <strong>{detailSession.taskTitle ?? "Hermes is managing the current task."}</strong>
                </div>
                <div>
                  <span className="meta-label">Project</span>
                  <strong>{detailSession.repoPath ?? "Current project not set"}</strong>
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
                </div>
              ) : null}

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
          <p>{session.taskTitle ?? session.statusText ?? "Working"}</p>
        </div>
        <span className={`phase-pill ${session.waitingOnUser ? "tone-attention" : "tone-working"}`}>
          {session.waitingOnUser ? "Waiting" : session.workerPhase ?? session.status}
        </span>
      </div>
      <p className="worker-summary">
        {session.managerSummary ?? session.pendingQuestion ?? session.lastUpdate ?? "Hermes is tracking this worker."}
      </p>
    </button>
  );
}
