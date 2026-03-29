# visionOS Client

Current purpose:
- render the mixed reality assistant window on Vision Pro
- preview the bundled 3D character asset
- connect to the Mac companion websocket event stream
- stay thin while the Mac companion remains the source of truth

## Current files

- `App/XRCodingAgentVisionApp.swift`
- `App/ContentView.swift`
- `App/ModelRealityView.swift`
- `App/ModelCatalog.swift`
- `App/EventModels.swift`
- `App/EventStreamClient.swift`
- `App/EventFeedView.swift`
- `Assets/Models/anime_girl.usdz`
- `scripts/stage_usdz.sh`
- `scripts/check_visionos_env.sh`
- `SETUP.md`

## Current assistant shell

The app currently includes:
- a RealityKit model preview panel
- assistant status and current-task summary cards
- recent event timeline from the Mac companion
- connect, reconnect, and disconnect controls

## Local development

1. In the repo you want Hermes to control, start the Mac companion:
   - `/Users/7upa/Desktop/xr-coding-agent/scripts/run-mac-companion.sh`
2. Open the Xcode project in `XRCodingAgentVision/`
3. Select `Apple Vision Pro` in the visionOS simulator
4. Run the app

## Voice flow

1. Put on the headset and open the app.
2. Tap `Start Listening`.
3. Speak a command like `run tests`.
4. Tap `Send Command`.
5. Hermes runs the task on the Mac and the headset speaks the summary when it finishes.

Read `SETUP.md` for simulator, device, and troubleshooting details.
