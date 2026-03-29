# Vision Pro Assistant Setup

Current first test asset:
- `apps/visionos-client/Assets/Models/anime_girl.usdz`

Helper scripts:
- `scripts/stage_usdz.sh /path/to/model.usdz`
- `scripts/check_visionos_env.sh`

## Goal

Run the XR Coding Agent assistant shell on the visionOS simulator or a real
Vision Pro, with live websocket events coming from the Mac companion.

## Current app source files

- `App/XRCodingAgentVisionApp.swift`
- `App/ContentView.swift`
- `App/ModelRealityView.swift`
- `App/ModelCatalog.swift`
- `App/EventModels.swift`
- `App/EventStreamClient.swift`
- `App/EventFeedView.swift`

These files are the current SwiftUI + RealityKit assistant shell for the
headset client.

## What is still needed on the Mac

Full Xcode is installed and selected on this Mac.

Verify that with:

```bash
xcodebuild -version
xcode-select -p
```

Expected developer dir:

```bash
/Applications/Xcode.app/Contents/Developer
```

The visionOS Xcode project already exists under:

- `apps/visionos-client/XRCodingAgentVision/`

## Fastest local startup

1. From the repo root, start the Mac companion:

   ```bash
   cd /path/to/the/repo-you-want-to-control
   /Users/7upa/Desktop/xr-coding-agent/scripts/run-mac-companion.sh
   ```

2. Open the Xcode project:

   - `/Users/7upa/Desktop/xr-coding-agent/apps/visionos-client/XRCodingAgentVision/XRCodingAgentVision.xcodeproj`

3. In Xcode, select a runnable destination:
   - `Apple Vision Pro` under `visionOS Simulator`
   - or your paired Vision Pro device

4. Run the app.

## Verify the USDZ asset

The bundled USDZ model should already be part of the project. If it ever goes
missing, re-add:

1. `Assets/Models/anime_girl.usdz`
2. check `Copy items if needed`
3. make sure the visionOS app target is checked
4. build again

The code expects the bundled resource name:
- `anime_girl`

So the file should be available in the app bundle as:
- `anime_girl.usdz`

## Test on simulator

1. Select `Apple Vision Pro` under `visionOS Simulator`
2. Run the app
3. Confirm:
   - the assistant window appears
   - the model is visible
   - the assistant status cards render
   - the fallback red box does NOT appear

## Test Mac companion events in the client

Once the Mac companion is running on the same Mac, the visionOS client can connect to:
- `ws://127.0.0.1:8765`

Inside the client UI:
1. Press `Connect` if it did not auto-connect
2. Trigger a command from the Mac companion like `run tests`
3. Confirm event cards appear for:
   - `session.started`
   - `session.output`
   - `session.finished` or `session.failed`
   - `agent.summary`
4. Confirm the assistant overview updates with the latest task summary

## Test headset voice commands

1. Launch the app in the simulator or on the headset
2. Grant microphone and speech recognition permissions when prompted
3. Tap `Start Listening`
4. Say a command such as:
   - `run tests`
   - `what happened`
   - `rerun it`
5. Tap `Send Command`
6. Confirm:
   - the transcript appears in the assistant window
   - the Mac companion receives the command
   - the app speaks the `agent.summary` reply when Hermes finishes

## Test on real Vision Pro

1. Pair the Vision Pro with Xcode on the Mac
2. Enable Developer Mode if prompted
3. Select the device in Xcode
4. Run the app
5. Confirm:
   - app launches on the headset
   - model appears in the window
   - status cards remain readable
   - moving the window keeps the model stable
   - the event panel connects once the Mac companion websocket server is running

## If the model does not appear

Check these first:
- the USDZ was added to the correct target
- the bundled name still matches `anime_girl`
- the file opens in Quick Look on macOS
- Xcode build log prints any `Failed to load USDZ` line

## Quick asset swap workflow

To test a different model later:
1. copy a new `.usdz` file into `Assets/Models/`
2. add it to the Xcode target
3. update `ModelCatalog.swift`
4. run again

## Next build steps

After this assistant shell works, the next useful upgrades are:
- push-to-talk voice input
- real speech-to-text and text-to-speech
- richer avatar state animations
- immersive space mode once the windowed workflow is solid
