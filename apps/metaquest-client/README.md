# Meta Quest Client

Thin Meta Quest frontend for XR Coding Agent. Hermes remains the manager. Claude and Codex remain managed workers on the Mac companion. This client connects to the existing event stream and control messages instead of moving orchestration into Quest.

## Why this path

This MVP uses a lightweight React/Vite Quest Browser client instead of Unity:

- fastest realistic route to a working Quest frontend in this repo
- keeps the client thin and backend-driven
- reuses the existing websocket event/control flow already used by the visionOS client
- now boots the embodied stage inside Meta's Immersive Web SDK world/runtime
- uses Meta's Immersive Web SDK dev plugin for Quest-style desktop emulation on `localhost`
- easy to test on desktop Chrome first, then open on Quest Browser on the LAN-hosted app URL

This is Quest-first and headset-usable, but it is intentionally not a native Unity shell yet.

## MVP included

- embodied Yuki stage running inside an IWSDK-managed XR world, with Three.js + VRM for the avatar runtime
- Hermes-first panel for typed prompts
- optional browser speech prompt when Web Speech API is available
- browser speech playback for Hermes replies so Yuki can speak in-headset
- worker board with worker labels, task titles, phases, pending state, and manager summaries
- signal feed for Hermes and worker updates
- worker detail view with live screen text or output tail
- approve, reject, and reply actions routed through Hermes
- secondary direct-to-worker input for manual intervention

## Run it

1. Start the Mac companion:
   - `cd /Users/7upa/Desktop/xr-coding-agent`
   - `./scripts/run-mac-companion.sh`
2. Install Quest client dependencies:
   - `cd /Users/7upa/Desktop/xr-coding-agent/apps/metaquest-client`
   - `npm install`
3. Start the Quest client dev server:
   - `npm run dev -- --host 0.0.0.0`
4. Open the client:
   - On the Mac: `http://localhost:5173`
   - On Quest Browser: `http://<your-mac-lan-ip>:5173`
5. In the client:
   - leave `Connection mode` on `Same-origin bridge` for the easiest local setup
   - connect, then use the Hermes panel to drive the session

## IWSDK desktop iteration

Local `npm run dev` includes Meta's official `@iwsdk/vite-plugin-dev` with a Quest 3 emulator and synthetic room environment, but only for `localhost`.

- this is for desktop iteration on the Mac without wearing the headset
- it does not affect Quest Browser sessions opened on your LAN IP, so headset behavior stays real
- it gives you a cleaner Meta-style XR debug loop while preserving the existing Hermes/Yuki app shell

## Safer Quest Browser transport

`Same-origin bridge` is now the recommended connection mode. The Vite dev server proxies websocket traffic from `/xr-agent-events` back to the Mac companion, so the headset stays on one origin instead of opening a separate raw socket.

- Vite proxy target defaults to `ws://127.0.0.1:8765`
- override it with `XR_METAQUEST_BACKEND_TARGET` if your Mac companion is listening elsewhere
- switch to `Direct socket` in the UI only if you intentionally want to connect straight to another websocket host/port

## Desktop vs headset testing after migration

Use `http://localhost:5173` for desktop IWSDK emulation and `http://<your-mac-lan-ip>:5173` in Quest Browser for the real headset path.

- desktop checks are best for layout, panel wiring, XR stage composition, and fast UI iteration
- headset checks are still required for WebXR permissions, tracking, controller input, speech behavior, and any mixed-reality quirks
- keep `Same-origin bridge` enabled for both paths unless you are intentionally testing a different websocket route
- treat localhost emulator success as a confidence signal, not a substitute for a Quest Browser pass

## Optional HTTPS for better headset WebXR compatibility

Quest Browser is happier with WebXR in a secure context. If you have a local cert and key, Vite can now serve HTTPS directly:

- `XR_METAQUEST_HTTPS_CERT=/absolute/path/to/cert.pem`
- `XR_METAQUEST_HTTPS_KEY=/absolute/path/to/key.pem`
- `npm run dev -- --host 0.0.0.0`

Then open:

- `https://<your-mac-lan-ip>:5173`

When you do that, keep `Connection mode` on `Same-origin bridge` so websocket traffic follows the same origin instead of getting blocked as mixed content.

## Production-style preview

- `cd /Users/7upa/Desktop/xr-coding-agent/apps/metaquest-client`
- `npm run build`
- `npm run preview -- --host 0.0.0.0`

Preview serves on port `4173` by default.

Note: the websocket bridge is implemented on the Vite dev server. If you use `preview`, connect with `Direct socket` unless you add your own reverse proxy in front of the preview server.

## Shared backend contract reused

The Quest client reuses the existing runtime payloads rather than inventing Quest-only models:

- `voice.command`
- `coding_sessions.sync`
- `terminal.input`
- `project.pick_folder`
- `worker.updated`
- `worker.pending_question`
- `hermes.status`
- `assistant.reply`
- `agent.summary`
- `terminal.started`
- `terminal.screen`
- `terminal.output`
- `terminal.finished`
- `terminal.failed`

## Additive backend change in this branch

One small, backward-compatible websocket message was added for targeted Quest approvals:

- `worker.reply`

Payload:

```json
{
  "type": "worker.reply",
  "payload": {
    "session_id": "term_123",
    "text": "approve",
    "route_via_manager": true
  }
}
```

This keeps worker approval and rejection routed through backend manager state instead of forcing the Quest UI to speak raw terminal input directly.

## Known gaps for Phase 2

- browser-first WebXR is now embodied, but the in-XR scene still needs more direct worker interaction surfaces
- no authenticated transport for headset-to-Mac traffic on LAN
- browser voice input support depends on Quest Browser speech APIs
- browser speech output is generic TTS, not backend-owned voice synthesis or true viseme timing
- room-aware MR and stronger scene understanding still need a deeper platform pass
- the shared event schema file in `shared/event-schema/v1.json` lags behind the runtime event set and should be refreshed
