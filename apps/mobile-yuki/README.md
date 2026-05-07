# Mobile Yuki

Standalone mobile phone system for embodied Hermes agents in XR.

This app surface is separate from the Quest browser client. Phone work lives here so iOS and Android can evolve as native mobile AR paths without coupling to `apps/metaquest-client`.

## Tracks

- `ios/` - native iPhone ARKit/RealityKit app scaffold for real camera-passthrough Yuki.
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
- local Hermes XR Gateway QR entry
- `yukimobile://connect?...` gateway-to-runtime handling on iOS

Android is documented as a separate native ARCore track but not scaffolded yet.
