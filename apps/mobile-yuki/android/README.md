# Mobile Yuki Android Track

Android mobile is a separate Mobile Yuki path, not the Quest browser path.

## Target

Native Android ARCore app with:

- Kotlin and Jetpack Compose app shell
- ARCore camera passthrough, hit tests, planes, anchors, light estimation, and depth where available
- SceneView, Filament, or a compact native renderer for Yuki
- OkHttp websocket transport to the Mac companion
- typed command first, microphone `voice.audio` second

## First Slices

1. Android project scaffold under `apps/mobile-yuki/android`.
2. ARCore session with plane hit-test placement.
3. Websocket client for `AgentWireEvent`.
4. `voice.command` send path.
5. Yuki model asset packaging and phase-driven animation.
6. Mobile spatial observation event draft once the Mac companion has a consumer.

Browser WebXR on Android can be evaluated later as a mobile fallback, but it should not reuse or depend on Quest client code.
