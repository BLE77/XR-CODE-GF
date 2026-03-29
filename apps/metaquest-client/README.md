# Meta Quest Client

Thin Meta Quest frontend for XR Coding Agent. Hermes remains the manager. Claude and Codex remain managed workers on the Mac companion. This client connects to the existing event stream and control messages instead of moving orchestration into Quest.

## Why this path

This MVP uses a lightweight React/Vite Quest Browser client instead of Unity:

- fastest realistic route to a working Quest frontend in this repo
- keeps the client thin and backend-driven
- reuses the existing websocket event/control flow already used by the visionOS client
- easy to test on desktop Chrome first, then open on Quest Browser using the same URL

This is Quest-first and headset-usable, but it is intentionally not a native Unity shell yet.

## MVP included

- Hermes-first panel for typed prompts
- optional browser speech prompt when Web Speech API is available
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
   - set `Mac host` to your Mac LAN IP if you are on the headset
   - keep websocket port `8765` unless you changed the Mac companion config
   - connect, then use the Hermes panel to drive the session

## Production-style preview

- `cd /Users/7upa/Desktop/xr-coding-agent/apps/metaquest-client`
- `npm run build`
- `npm run preview -- --host 0.0.0.0`

Preview serves on port `4173` by default.

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

- no native immersive WebXR surface yet, only Quest Browser panels
- no authenticated transport for headset-to-Mac traffic on LAN
- browser voice input support depends on Quest Browser speech APIs
- the shared event schema file in `shared/event-schema/v1.json` lags behind the runtime event set and should be refreshed

