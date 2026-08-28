# XR Coding Agent

XR Coding Agent is a Meta Quest browser companion for coding with a spatial AI operator. The Mac companion runs the real agent/workers, while the Quest app gives you a mixed-reality Yuki/Hermes interface for voice, panels, worker activity, and live terminal streams.

The public demo path is:

1. Start the Mac companion.
2. Start the Quest web client over HTTPS.
3. Open the URL in Quest Browser.
4. Talk to Yuki/Hermes and ask it to open Codex, Claude Code, Hermes CLI, or Kimi Code workers.

## What It Does

- Runs a local Mac websocket companion for Hermes-style orchestration.
- Shows an embodied Yuki stage in Meta Quest Browser with draggable XR panels.
- Supports OpenAI Realtime voice for low-latency voice-to-voice turns.
- Supports ElevenLabs streaming TTS for Yuki speech.
- Opens and monitors managed coding workers on the Mac:
  - Codex CLI
  - Claude Code
  - Hermes CLI
  - Kimi Code
- Streams worker status, live terminal output, and screen snapshots into the Quest UI.
- Routes voice commands like `open Kimi Code here`, `tell Codex run the build`, and `what needs me next?` back to the Mac companion.

## Repo Layout

```text
apps/
  mac-companion/      Mac-side websocket server, voice bridge, worker manager
  metaquest-client/   React/Vite Quest Browser XR app
  metaquest-native/   Native Quest scaffold and planning notes
  mobile-yuki/        iOS/Android native AR companion experiments
  visionos-client/    Vision Pro spatial client scaffold
docs/                 XR UI, animation, native, and execution notes
shared/               Shared prompts and event schema
scripts/              Local launch helpers
```

## Requirements

- macOS for the companion process.
- Python 3.11+.
- Node.js 20+.
- A Meta Quest headset with Quest Browser.
- Local network access between the Quest and the Mac.
- Optional worker CLIs on your `PATH`: `codex`, `claude`, `hermes`, and `kimi`.
- Optional API accounts:
  - OpenAI for Realtime voice.
  - ElevenLabs for low-latency TTS.
  - Kimi Code login or API key for Kimi workers.

## Safe Setup

Never commit real API keys. This repo includes placeholder env files only.

```sh
cp .env.example .env.local
cp apps/metaquest-client/.env.example apps/metaquest-client/.env.local
```

There are two different env files:

- `.env.local` is for the Mac companion. Put API keys and local worker settings here.
- `apps/metaquest-client/.env.local` is for the Vite/Quest web app. Put only local browser/dev-server settings here, not API keys.

The app can launch without every optional provider, but features turn on based on what you configure:

| Feature | What You Need | What Happens If Missing |
| --- | --- | --- |
| Basic Quest UI + worker board | Mac companion running, Quest client running | The headset has no live backend connection |
| Open Codex/Claude/Hermes workers | The matching CLI on your Mac `PATH` | That worker fails to open |
| Open Kimi workers | `kimi` CLI installed and `kimi login` completed, or a valid `KIMI_API_KEY` | Kimi opens but cannot answer |
| OpenAI Realtime voice | Hermes `openai-codex` OAuth login in `~/.hermes/auth.json` | Live voice session fails or stays text-only |
| ElevenLabs Yuki speech | `ELEVENLABS_API_KEY` and ideally `ELEVENLABS_VOICE_ID` in root `.env.local` | Backend TTS is disabled or falls back |
| Quest Browser WebXR | HTTPS cert paths in `apps/metaquest-client/.env.local` | Quest may block XR/mic permissions |

Minimum root `.env.local` for the full voice demo:

```sh
OPENAI_REALTIME_PROFILE=demo
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
```

Realtime voice profiles:

- `OPENAI_REALTIME_PROFILE=demo`: lowest-latency funny demo/video mode. Defaults to `gpt-realtime-1.5`.
- `OPENAI_REALTIME_PROFILE=operator`: smarter real-use mode for tool routing and ambiguous tasks. Defaults to `gpt-realtime-2` with low reasoning.

Hermes should stay the main brain in both modes. The Realtime model is the fast mouth/ear; actionable coding, memory, worker, panel, and Yuki behavior requests route back to the Mac companion.

## Shared Hermes Memory

The Quest companion and the regular Hermes CLI should use the same Hermes identity and durable memory by default because they both run through your local Hermes install and profile under `~/.hermes`. They do not need to share the exact same chat transcript for this to work.

For the seamless path:

- Put long-term facts, preferences, reminders, and personality defaults in Hermes memory, not in the Quest browser.
- Keep OpenAI Realtime as the fast voice layer only. It should route memory, reminder, worker, repo, UI, and Yuki behavior requests back to Hermes.
- Start the Mac companion before opening the headset app so XR voice has the Hermes backend available.
- When you want a normal terminal Hermes session that can also see/control the XR-managed workers, run:

```sh
./scripts/run-hermes-xr.sh
```

That helper launches `hermes -t xr-managed-sessions` with the XR control bridge env vars set. A plain `hermes` command still uses the same Hermes profile and memory, but it will not automatically see the live XR worker bridge unless those env vars are present.

Recommended Quest client `.env.local`:

```sh
XR_METAQUEST_BACKEND_TARGET=ws://127.0.0.1:8765
XR_METAQUEST_HTTPS_CERT=.certs/quest-cert.pem
XR_METAQUEST_HTTPS_KEY=.certs/quest-key.pem
VITE_XR_ENABLE_BRIDGE=true
```

For Kimi Code, the safest setup is OAuth:

```sh
uv tool install kimi-cli
uv tool upgrade kimi-cli --no-cache
kimi login
```

Only set `KIMI_API_KEY` if you have a valid Kimi Code API key. A bad `KIMI_API_KEY` overrides the working OAuth login.

## Install

From the repo root:

```sh
python3 -m pip install -e apps/mac-companion
cd apps/metaquest-client
npm install
```

## Run The Mac Companion

From the repo root:

```sh
./scripts/run-mac-companion.sh
```

Expected output includes:

```text
XR coding agent ready.
WebSocket: ws://0.0.0.0:8765
Pair once (expires ...): ?pair=ONE_TIME_CODE
```

The external app-created event server requires authentication. Append the printed one-time pairing value to the Quest page URL (for example `https://MAC:5173/?pair=ONE_TIME_CODE`). The browser exchanges it once, stores the returned device token in local storage, and uses `?token=...` on later WebSocket connections. The Mac persists only salted PBKDF2 token hashes in `~/.xr-coding-agent/device-auth.json` (mode `0600`). Restart the companion to print a new five-minute pairing code.

For direct TLS, set both `XR_AGENT_WSS_CERT` and `XR_AGENT_WSS_KEY`; the event server then listens with WSS. On a tailnet, prefer the Mac's Tailscale DNS name/IP and keep the port restricted to the tailnet with macOS firewall/Tailscale ACLs. Tailscale supplies private transport reachability, but device pairing is still required. Never expose plain `ws://0.0.0.0:8765` to the public internet.

## Run The Quest Client

Quest Browser WebXR works best on HTTPS. Generate local certs with `mkcert`:

```sh
brew install mkcert
mkcert -install
mkdir -p apps/metaquest-client/.certs
mkcert \
  -key-file apps/metaquest-client/.certs/quest-key.pem \
  -cert-file apps/metaquest-client/.certs/quest-cert.pem \
  localhost 127.0.0.1 YOUR_MAC_LAN_IP
```

Then start the client:

```sh
cd apps/metaquest-client
npm run dev:https
```

Open this on the Quest:

```text
https://YOUR_MAC_LAN_IP:5173
```

Keep the connection mode on `Same-origin bridge`. That lets the Quest page use `/xr-agent-events` on the same HTTPS origin instead of opening a separate insecure websocket.

## Demo Voice Commands

Try these in XR:

```text
open Kimi Code here
tell Kimi inspect the XR UI
open Codex here
tell Codex run the build
what coding sessions are open?
what needs me next across the active workers?
```

When a worker opens, the worker activity panel should show the worker label, command, live status, terminal stream, and latest screen text.

## Voice Modes

OpenAI Realtime voice is handled server-side by the Mac companion. The Mac reads the existing `openai-codex` OAuth token and account ID, posts the browser SDP to `/v1/realtime/calls`, and returns only the SDP answer plus non-secret session configuration to the requesting device. OAuth credentials are never broadcast or sent to the headset. The headset applies the session configuration with `session.update` after its WebRTC data channel opens.

Recommended `.env.local` defaults:

```sh
OPENAI_REALTIME_PROFILE=demo
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

For real-use testing where voice should be better at routing tools and state, switch to:

```sh
OPENAI_REALTIME_PROFILE=operator
```

ElevenLabs streaming TTS is optional but useful for low-latency Yuki speech:

```sh
XR_AGENT_VOICE_PROVIDER=elevenlabs
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_TTS_MODE=streaming
ELEVENLABS_OUTPUT_FORMAT=mp3_22050_32
```

## Event Replay And Worker Sync

Websocket reconnects intentionally replay only compact high-signal events. The Mac companion never replays `session.output`, `terminal.output`, `terminal.screen`, or events that contain backend audio payloads such as `audio_base64`. Oversized event fields are truncated or replaced with explicit stripped markers before they enter the event queue/history.

The Quest worker board should refresh through `coding_sessions.sync`. The response is one `coding_sessions.synced` event with compact real backend snapshots: session ID, worker label, tool label, repo path, status/phase, pending question, manager summary, small output summary, and timestamps. Sync snapshots do not include full terminal screens, raw output tails, or audio. Live `terminal.output` and `terminal.screen` may still stream to already-connected clients, but reconnect state comes from the compact sync event.

## Troubleshooting

- Quest cannot open XR: use HTTPS, not plain HTTP.
- Quest cannot connect to Hermes: confirm the Mac companion is running on port `8765`.
- Worker board is empty: tap refresh workers or say `what coding sessions are open?`.
- Kimi opens but does not answer: run `kimi login` again, and make sure `KIMI_API_KEY` is not set to an invalid key.
- Browser preview works but Quest does not: test on the `https://YOUR_MAC_LAN_IP:5173` URL, not `localhost`.
- Voice starts then stops: restart the realtime session and confirm Hermes has a valid `openai-codex` OAuth login on the Mac.

## Public Repo Safety

This repo is intended to be public-safe, but local development can create sensitive files. Do not commit:

- `.env`, `.env.local`, or any file containing API keys.
- `apps/metaquest-client/.certs/`.
- `.mcp.json` or local MCP/tool configs.
- `.server-logs/`.
- local screenshots/logs that show terminals or secrets.

Before publishing changes, run:

```sh
git status --short
git grep -nE "sk-proj-|sk-kimi-|gh[pousr]_|-----BEGIN .*PRIVATE KEY-----" -- . ':!README.md'
npm run build --prefix apps/metaquest-client
python3 -m pytest apps/mac-companion/tests -q
```

The grep command should print nothing. Placeholder env names in docs/examples are okay.

## Project Status

This is an active hackathon-style XR coding companion. The browser Quest path is the main demo surface today; native Quest, mobile Yuki, and Vision Pro paths are still experimental.
