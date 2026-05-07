# Mobile Yuki Wire Contract

Mobile Yuki reuses the Mac companion websocket contract for the first scaffold. New mobile-specific events should be added only when the companion has a consumer.

## Connection

Development clients connect directly to:

```text
ws://<mac-lan-ip>:8765
```

Production transport still needs authentication and secure pairing.

## Messages Sent By Mobile

Already supported:

- `coding_sessions.sync`
- `voice.command`
- `voice.audio`
- `terminal.input`
- `worker.reply`

Initial iOS scaffold sends:

```json
{
  "type": "voice.command",
  "payload": {
    "text": "run tests",
    "repo_path": "/Users/7upa/Desktop/xr-coding-agent"
  }
}
```

Planned mobile-specific events:

- `mobile.session.joined`
- `mobile.capabilities`
- `mobile.spatial_observation`

## Messages Received By Mobile

Mobile clients should react to:

- `speech.transcript`
- `avatar.thinking`
- `avatar.speaking`
- `assistant.reply`
- `hermes.status`
- `agent.summary`
- `worker.updated`
- `worker.pending_question`
- `terminal.started`
- `terminal.finished`
- `terminal.failed`

## Gateway And Deep Link Draft

Local gateway QR:

```text
http://<mac-lan-ip>:5183/?agent=yuki&host=<mac-lan-ip>&port=8765&platform=auto
```

The local gateway is the first phone entry point. It displays the Hermes agent body handoff and then opens the native runtime.

Native runtime handoff:

```text
yukimobile://connect?host=<mac-lan-ip>&port=8765&scheme=ws&platform=ios&agent=yuki
```

Production should move to Universal Links/App Links on a real domain.
