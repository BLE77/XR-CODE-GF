# Hermes XR Gateway Mobile Yuki Workflow

Mobile Yuki should get its own Hermes XR Gateway workflow instead of reusing Quest launch behavior. The gateway is the local web entry point; native ARKit/ARCore apps are XR body runtimes behind it.

## Development Entry

Hermes skill command:

```bash
python3 /Users/7upa/.hermes/skills/software-development/yuki-mobile-xr/scripts/start_mobile_xr.py
```

Responsibilities:

- find `/Users/7upa/Desktop/xr-coding-agent`
- start or reuse `scripts/run-mac-companion.sh`
- detect the Mac LAN IP
- start a local Hermes XR Gateway page
- print a gateway QR payload
- expose iOS and Android native deep-link handoffs
- keep the old browser fallback behind `--legacy-quest-web-fallback`
- avoid starting or modifying `apps/metaquest-client`

## QR Payloads

Default gateway dev:

```text
http://<mac-lan-ip>:5183/?agent=yuki&host=<mac-lan-ip>&port=8765&platform=auto
```

iOS runtime handoff:

```text
yukimobile://connect?platform=ios&host=<mac-lan-ip>&port=8765&scheme=ws&agent=yuki
```

Android runtime handoff:

```text
yukimobile://connect?platform=android&host=<mac-lan-ip>&port=8765&scheme=ws&agent=yuki
```

Production should use Universal Links for iOS and App Links for Android on a real HTTPS domain.

## Client Boot Sequence

1. User scans local gateway QR.
2. Gateway shows the selected Hermes agent and Mac companion websocket.
3. Gateway opens the best available XR body runtime for the phone.
4. Native app receives deep-link payload.
5. App stores host, port, scheme, and agent.
6. App opens the AR surface directly.
7. App connects to the Mac companion websocket.
8. App sends `coding_sessions.sync`.
9. App starts with typed command and later enables microphone `voice.audio`.

## Boundary

Quest launch scripts, Quest browser QR URLs, and `apps/metaquest-client` stay outside this workflow.
