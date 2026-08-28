# Mobile Yuki iOS

Native iPhone ARKit/RealityKit track for Mobile Yuki.

This is the real iPhone AR path. It is separate from `apps/metaquest-client` and does not depend on Safari WebXR.

## Current Scaffold

- Full-screen `ARView` camera passthrough.
- Fallback Yuki marker placed by ARKit raycast or in front of the camera.
- Thin websocket client that reuses the Mac companion wire protocol.
- Typed `voice.command` send path for the first native integration check.
- Continuous AVAudioEngine microphone capture converted to 48 kHz mono PCM16.
- Authenticated binary audio streaming to the Mac-side OpenAI Realtime relay.
- Streaming Hermy reply playback, server VAD state, barge-in, and reconnect handling.
- `yukimobile://connect?...` deep-link parsing for gateway-launched host/port setup.
- XcodeGen project spec in `XRCodingAgentMobileIOS/project.yml`.

## Run

1. Start the Mac companion:

```bash
cd /Users/7upa/Desktop/xr-coding-agent
./scripts/run-mac-companion.sh
```

2. Generate and open the iOS project:

```bash
cd /Users/7upa/Desktop/xr-coding-agent/apps/mobile-yuki/ios/XRCodingAgentMobileIOS
xcodegen generate
open MobileYukiIOS.xcodeproj
```

3. Select a physical iPhone target, set a signing team, and run.

4. In the app, enter the Mac LAN IP and port `8765`, connect, place Yuki, and send a typed command.

Or start the Hermes XR Gateway skill launcher and scan the QR after the app is installed on the phone:

```bash
python3 /Users/7upa/.hermes/skills/software-development/yuki-mobile-xr/scripts/start_mobile_xr.py --platform ios
```

The QR opens the local gateway first. The gateway then opens this app as the iPhone XR body runtime.

For the encrypted tailnet path, first bring the iPhone online in Tailscale, then run:

```bash
python3 /Users/7upa/.hermes/skills/software-development/yuki-mobile-xr/scripts/start_mobile_xr.py --direct-native-link --platform ios --tailscale
```

The QR contains a Mobile Yuki pairing token, never the OpenAI credential. The token and generated QR file are stored with mode `0600`; plaintext logs redact token parameters.

## Notes

- Use a physical iPhone for AR camera passthrough. The simulator is useful for compile checks only.
- The first native build uses a generated RealityKit placeholder until the iOS Yuki USDZ is chosen.
- App Clip routing should come after the native iOS app can connect, place Yuki, and speak/listen reliably.
