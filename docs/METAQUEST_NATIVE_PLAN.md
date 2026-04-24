# Meta Quest Native Embodiment Plan

## Decision

The browser Quest client stays useful for rapid iteration and backend validation, but it is not the final product for an embodied assistant. The native Quest path should be built with Unity and OpenXR while preserving the existing Hermes-driven control plane.

## Why

- the product requirement is a character in XR, not only a dashboard
- Quest-native avatar presence, room placement, passthrough, and input lifecycles need native control
- the repo already proves Hermes can drive thin frontends
- Swift/RealityKit code from visionOS is not portable, but its UX hierarchy is reusable

## Reuse

- Mac companion event/control protocol
- Hermes worker/session state model
- manager summaries and pending decision semantics
- voice command routing
- visionOS UX hierarchy:
  - Hermes first
  - workers second
  - high-signal summaries over raw terminal babysitting

## Build slices

### Slice 1

- native Quest app boots
- connects to websocket backend
- Hermes status appears in world space

### Slice 2

- one embodied Hermes character
- state machine:
  - idle
  - listening
  - speaking
  - working
  - alert

### Slice 3

- worker board
- worker detail surface
- approve, reject, and reply actions

### Slice 4

- room-aware placement
- hand interaction polish
- better avatar and animation assets
- comfort tuning and performance tuning

## Current repo work

The repo now contains a native Quest scaffold at [apps/metaquest-native](/Users/7upa/Desktop/xr-coding-agent/apps/metaquest-native) with:

- Unity project structure
- package manifest for OpenXR + Meta XR SDK
- websocket bridge/runtime state scripts
- Yuki avatar driver hooks
- bundled temporary `Yuki.vrm` asset

Unity is still not installed on this machine, so the remaining work that requires the editor is:

- scene creation
- prefab wiring
- Quest build validation
- final avatar import/runtime hookup
