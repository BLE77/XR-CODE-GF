# Mobile Yuki

Standalone mobile phone system for embodied Hermes agents in XR.

This app surface is separate from the Quest browser client. Phone work lives here so iOS and Android can evolve as native mobile AR paths without coupling to `apps/metaquest-client`.

## Tracks

- `ios/` - native iPhone ARKit/RealityKit app scaffold for real camera-passthrough Yuki.
- `web/` - no-install, tailnet-only Three.js Yuki viewer with camera mode and iPhone AR Quick Look placement.
- `android/` - Android ARCore track notes and future native app surface.
- `contracts/` - mobile-owned websocket, gateway, and deep-link contracts.
- `workflows/` - Hermes Mobile Yuki workflow notes.
- `workflows/` - Hermes/mobile launch workflow notes.

## Boundaries

- Do not modify `apps/metaquest-client` for Mobile Yuki work.
- Do not route mobile phone work through Quest staged phone mode.
- Keep Mobile Yuki clients thin: AR rendering, speech capture, spatial signals, and websocket transport.
- Keep Hermes/Mac companion as the source of task and conversation continuity.

## Current Status

The iOS scaffold can type-check against the iOS simulator SDK and includes:

- full-screen ARKit/RealityKit camera passthrough
- fallback Yuki marker placement
- websocket connection to the Mac companion
- typed `voice.command` send path
- authenticated continuous 48 kHz microphone streaming to the Mac-side Realtime relay
- streamed Hermy PCM playback with interruption and automatic reconnect
- full durable `ask_hermy` delegation through the same Voice Hermy task store
- local Hermes XR Gateway QR entry
- `yukimobile://connect?...` gateway-to-runtime handling on iOS, including Realtime port and pairing token

The Realtime relay lives at `gateway/mobile_realtime_gateway.py`. OpenAI credentials never leave the Mac. The phone receives only an app-specific pairing token. LAN development can use a direct relay address; `--tailscale` keeps the relay on loopback and exposes authenticated WSS through Tailscale Serve at the Mac's MagicDNS name. Native iOS sends the pairing token in an Authorization header and stores it in this-device-only Keychain storage.

The no-install web surface lives at `web/`. Its current experience is explicitly a camera-backed Three.js overlay—not spatially tracked AR—using Yuki's textured GLB, named humanoid bones, and face morphs for idle, listening, thinking, speaking, blinking, and mouth motion. It also links to the private Hermy voice surface and is served through tailnet-only Tailscale HTTPS. The automatic USDZ/Quick Look conversion is not the preferred path: physical-device testing exposed lost materials and a T-pose, so it remains disabled until Yuki has a properly authored USDZ animation/material package.

On iOS, the camera feed is uploaded into Three.js as a cover-cropped `VideoTexture` instead of remaining a full-screen DOM `<video>`. This avoids Safari's hardware-video compositor covering the WebGL avatar. The intended visual order is camera background, animated Yuki, then glass DOM overlays.

Android is documented as a separate native ARCore track but not scaffolded yet.
