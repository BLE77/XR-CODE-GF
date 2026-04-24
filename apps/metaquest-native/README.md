# Meta Quest Native Client

Native Quest project root:
- [apps/metaquest-native](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native)

Implemented native runtime pieces:
- [QuestBackendBridge.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/Networking/QuestBackendBridge.cs)
- [AgentWireEvent.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/Protocol/AgentWireEvent.cs)
- [AppModels.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/State/AppModels.cs)
- [QuestNativeStateStore.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/State/QuestNativeStateStore.cs)
- [QuestNativeBootstrap.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/App/QuestNativeBootstrap.cs)
- [YukiAvatarDriver.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/Avatar/YukiAvatarDriver.cs)
- [CompanionPlacementController.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/Spatial/CompanionPlacementController.cs)
- [WorldPanelLayoutController.cs](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/Scripts/Runtime/Spatial/WorldPanelLayoutController.cs)

Temporary avatar asset:
- [Yuki.vrm](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Assets/StreamingAssets/Avatars/Yuki.vrm)

## Product rule

- Hermes remains the backend brain and manager.
- Yuki is the embodied native frontend shell.
- Claude/Codex remain managed workers.
- Quest stays a frontend over the existing control plane.

## What the native scaffold already covers

- websocket bridge to the current Mac companion
- shared worker/session/event reduction
- Hermes phase derivation
- Yuki talking / thinking / listening / alert hooks
- manager-routed worker replies
- summonable worker detail surfaces
- room-front placement controller
- world-panel layout controller

## What still requires Unity/editor work

- opening the project in Unity and resolving packages
- creating the first actual scene and prefabs
- swapping the placeholder/avatar hookup for the real Yuki rig
- configuring Android + OpenXR + Quest project settings
- adding passthrough / scene understanding if you want true room-aware MR
- controller / hand interaction polish

## Packages already declared

- `com.meta.xr.sdk.core`
- `com.meta.xr.sdk.interaction`
- `com.unity.xr.management`
- `com.unity.xr.openxr`
- `com.unity.inputsystem`
- `com.unity.textmeshpro`
- `com.unity.nuget.newtonsoft-json`

Source:
- [Packages/manifest.json](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native/Packages/manifest.json)

## Open the native app

1. Open [apps/metaquest-native](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native) in Unity.
2. Let Unity resolve packages.
3. Switch build target to Android.
4. Enable OpenXR + Quest support.
5. Create a scene under `Assets/Scenes/`.
6. Add:
   - `QuestBackendBridge`
   - `QuestNativeBootstrap`
   - `YukiAvatarDriver`
   - `CompanionPlacementController`
   - `WorldPanelLayoutController`
7. Bind the world-space text/panel references.
8. Set backend host/port to the Mac companion.
9. Build to Quest.

## Backend run command

```bash
cd /Users/7upa/Desktop/xr-coding-agent
./scripts/run-mac-companion.sh
```

## Current reality

This is now a real native Quest scaffold in the repo, but it is not editor-verified on this machine because Unity is not installed here. The browser Quest client remains the only runnable headset path from this environment until the Unity project is opened on a machine with the Unity editor and Android/Quest toolchain.
