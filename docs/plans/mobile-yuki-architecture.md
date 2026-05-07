# Mobile Yuki Architecture Plan

Goal: Define and start the standalone Hermes XR Gateway and Mobile Yuki phone AR path so QR-launched iPhone and Android users can talk to embodied Hermes agents in mobile-owned mixed reality clients instead of the Quest browser path.

Scope update: Mobile phone work is its own `Mobile Yuki` system. It must not be mixed into the Quest browser client. iPhone and Android are separate mobile tracks with their own app surface, launch workflow, Hermes skill/workflow, and integration contracts.

Product framing: the web entry is a local Hermes XR Gateway, not the final body runtime. The gateway pairs a Hermes agent/session with an XR body and hands off to the best available runtime on the phone.

## Non-Negotiable Boundaries

- Do not modify `apps/metaquest-client` for mobile phone work.
- Do not reuse Quest UI, IWSDK setup, or staged browser fallback code as the mobile app surface.
- Treat Quest code only as historical context for the websocket contract and Yuki behavior concepts.
- Keep phone app code under `apps/mobile-*`.
- Keep launch, QR, and Hermes workflow docs mobile-specific.
- Do not try to make iPhone Safari WebXR immersive AR work.

## System Shape

```text
apps/mobile-yuki/
  README.md
  contracts/
    mobile-yuki-wire.md
  ios/
    README.md
    App/
    XRCodingAgentMobileIOS/
  android/
    README.md
docs/plans/
  mobile-yuki-architecture.md
```

The mobile system owns:

- local gateway QR entry and pairing
- phone-first app UI and permissions
- AR camera passthrough and placement
- mobile speech capture and reply playback
- mobile spatial observation streams
- mobile QR/deep-link routing
- Hermes mobile workflow entrypoints

The Mac companion remains the backend brain. Mobile clients stay thin: render Yuki, collect voice/spatial signals, send events to Hermes, and reflect Hermes state.

## Platform Tracks

### iOS Track

First build target: native iOS app with ARKit, RealityKit, SwiftUI, and the existing Mac companion websocket.

Rationale:

- iPhone real AR requires native ARKit/RealityKit camera passthrough.
- A normal installed dev app is the fastest route to validate camera, local network, mic, placement, and Hermes events.
- App Clip adds Associated Domains, size limits, signing, and review complexity before the AR loop is proven.
- A shared Apple package is useful later, after the iOS app and visionOS app have a stable overlap worth extracting.

Initial iOS modules:

- `YukiIOSClient`: websocket client using `AgentWireEvent`, `voice.command`, and later `voice.audio`.
- `YukiARView`: `ARView(cameraMode: .ar)`, ARKit world tracking, plane raycast placement, fallback placement in front of the camera.
- `YukiARSceneModel`: placement state and app-to-AR requests.
- `YukiARContentView`: direct app surface over the AR view.

### Android Track

Second build target: separate Android mobile app, not Quest browser.

Recommended stack:

- Kotlin/Jetpack Compose for the phone UI.
- ARCore for camera passthrough, hit tests, planes, anchors, light estimation, and depth when available.
- SceneView, Filament, or a small native rendering layer for Yuki.
- OkHttp websocket client for the Mac companion contract.

Android browser WebXR can be a research fallback only if it lives under the mobile system and does not route through Quest code. The main Android mobile path should be ARCore-native for parity with iOS-native AR.

## Contract Reuse

Use the Mac companion websocket as the shared brain/control contract:

Incoming from Mac:

- `speech.transcript`
- `avatar.thinking`
- `avatar.speaking`
- `assistant.reply`
- `hermes.status`
- `agent.summary`
- `worker.updated`
- `worker.pending_question`
- session and terminal events

Outgoing from mobile:

- `coding_sessions.sync`
- `voice.command`
- `voice.audio`
- later: `mobile.spatial_observation`
- later: `mobile.session.joined`
- later: `mobile.capabilities`

Do not add new event schema entries until the Mac companion has a consumer. The first native scaffold should only use already-supported messages.

## Mobile Spatial Model

Phase one:

- place Yuki on a raycast floor/plane target
- fallback to camera-relative placement when planes are not ready
- face Yuki toward the phone camera
- move Yuki toward a comfortable conversation distance after user speech

Phase two:

- stream compact planes, anchors, and hit-test results as mobile spatial observations
- derive floor, table, seat, and blocked affordances in a mobile-owned behavior layer
- expose the same high-level affordance vocabulary on iOS and Android

Phase three:

- native object detection or companion-side semantic labeling
- object boxes for chairs, couches, desks, tables, and obstacles
- sit, climb, jump, avoid, and point behaviors

## Hermes Skill And Workflow

The mobile workflow is a separate Hermes skill/workflow from Quest launch:

```text
~/.hermes/skills/software-development/yuki-mobile-xr/
  SKILL.md
  scripts/start_mobile_xr.py
apps/mobile-yuki/workflows/
  hermes-mobile-yuki.md
```

Responsibilities:

- start or detect the Mac companion on port `8765`
- start a mobile-owned local Hermes XR Gateway, usually on port `5183`
- print a gateway QR, not a Quest browser QR
- include native deep-link payloads for iOS and Android
- keep staged browser fallback clearly marked as fallback only
- eventually install/check native app prerequisites

Development gateway QR shape:

```text
http://<mac-lan-ip>:5183/?agent=yuki&host=<mac-lan-ip>&port=8765&platform=auto
```

Gateway-to-runtime deep-link payload shape:

```text
yukimobile://connect?host=<mac-lan-ip>&port=8765&scheme=ws&platform=ios&agent=yuki
```

The launcher defaults to the local gateway QR and only starts the old Quest browser fallback when passed `--legacy-quest-web-fallback`. A direct native app QR remains available with `--direct-native-link`.

Production/App Clip/Instant App routing should use Universal Links/App Links on a real HTTPS domain. LAN IP plus self-signed certificate is acceptable for dev only.

## QR Routing

Current Quest/browser phone URL remains untouched:

```text
https://<mac-lan-ip>:5173/?phone=1
```

Mobile Yuki QR should be separate:

- default: local Hermes XR Gateway URL
- iOS installed app handoff: `yukimobile://connect?...`
- Android installed app handoff: `yukimobile://connect?...`
- iOS App Clip later: Universal Link with App Clip association
- Android Instant App later: Android App Link
- browser fallback: an explicit mobile fallback page, not the Quest app

No routing change should land in `apps/metaquest-client`. A separate mobile launcher page or small companion endpoint can own phone detection later.

## Validation

Local iOS scaffold checks:

```bash
cd apps/mobile-yuki/ios/XRCodingAgentMobileIOS
xcodegen generate
xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -target arm64-apple-ios17.0-simulator ../App/*.swift
```

Device iOS checks:

- build to a physical ARKit-capable iPhone
- grant Camera and Local Network permissions
- connect to `ws://<mac-lan-ip>:8765`
- place Yuki in camera passthrough
- send a typed `voice.command`
- verify Hermes events update Yuki phase

Android checks when scaffolded:

- build from Android Studio with ARCore dependency installed
- run on an ARCore-supported Android phone
- grant Camera, Microphone, and Local Network permissions
- connect to the same Mac companion websocket
- validate ARCore hit-test placement and event-driven Yuki state

## Blockers

- No iOS signing team or final bundle ID is selected.
- No Android module is implemented yet; only the track boundary is documented.
- No final mobile Yuki asset package is selected for iOS or Android.
- Android deep-link parsing is not implemented yet.
- The Mac companion websocket is unauthenticated LAN transport.
- Real room item awareness still needs mobile spatial observation events and companion consumers.
