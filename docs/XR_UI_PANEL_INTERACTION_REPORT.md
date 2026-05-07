# XR UI Panel Interaction Report

Date: 2026-05-04

## Bottom line

Real XR panels are not hover-reactive cards and they are not a flat browser preview floating in 3D. They are independent spatial windows: world-locked by default, movable only through explicit grab/drag affordances, and operated through both far ray input and near direct input.

For XR Coding Agent, the correct target is closer to Meta Horizon OS panels and Microsoft slates than a web dashboard. Each coding surface should be its own panel/window with chrome, handles, persistent placement, and clear input states.

## What Actual XR Platforms Do

### Meta Horizon OS / Quest

Meta describes panels as rectangular surfaces for 2D app content. The panel content itself fills the panel; the panel title and actions live in a separate control bar that appears below the panel when hovered.

Important Meta patterns:

- A single panel can be moved by grabbing an edge or the control bar.
- A panel can be resized by dragging corners.
- A group or hinged layout has its own manipulation handle, separate from individual panel movement.
- Windows expose a display bar for grouped layouts and a control bar for individual windows.
- Edge handles appear on hover and are used for repositioning.
- Resize handles appear on hover at corners and are used for resizing.
- Ray casting is for distant interaction, with visible ray/cursor/hover feedback.
- Hover is feedback only. Movement starts on select-and-hold, grab, or drag.
- Direct touch should use the index finger, with touch limiting so hands do not visually clip through the panel.
- Touch targets should be large enough for XR: Meta recommends at least `22mm x 22mm` with `12mm` spacing.

Implication: our panels should not move forward, resize, recenter, or change spatial pose from hover. Hover should reveal cursor, focus, edge handles, corner handles, and the control bar.

### WebXR / Quest Browser

WebXR does not make in-world canvas panels interactive automatically. It gives us tracked input sources, target rays, `select` events, `squeeze` events, reference spaces, and poses. We still have to implement ray-to-panel hit testing, local canvas coordinate mapping, drag capture, and stable panel transforms.

Correct WebXR model:

- Use `XRInputSource` as the canonical input object.
- Use `targetRaySpace` for far ray targeting.
- Use `selectstart/select/selectend` for primary click/select behavior.
- Use `squeezestart/squeeze/squeezeend` for controller grab behavior where available.
- For hand input, do not assume `squeeze`; pinch is often exposed as `select`.
- Latch the panel and hit point at gesture start. Do not recompute the dragged object every frame.
- Release drag on `selectend` or `squeezeend`, even if the ray is no longer hitting the panel.
- Use `local-floor` or similar stable reference spaces for world-locked panels. Avoid `viewer` for persistent panels because it behaves like a head-following HUD.

Implication: the panel system needs explicit interaction state per input source, not one global deck state.

### Apple Vision Pro / visionOS

Apple’s interaction model reinforces the same human pattern:

- People look at an item and pinch/tap to select.
- People pinch-and-drag to move items.
- Window bars are used for arranging app windows.
- Direct touch exists, but frequent direct use can be tiring; indirect interaction is the comfortable default for common UI.

Implication: far interaction must be first-class. Coding in XR should not require holding arms forward.

### Microsoft Mixed Reality / MRTK

Microsoft’s “slate” is the closest non-Meta analogue: a thin 2D window for text, images, documents, or browser-like content. It has a grabbable title bar, close/follow controls, direct scrolling, gaze/ray/air-tap, and controller pointer support.

Important Microsoft patterns:

- Use distinct input states: default, targeted/hover, pressed, grabbed.
- Use bounding boxes and app bars to show when an object is adjustable.
- Corners imply scaling.
- Edge affordances imply rotation/repositioning.
- App bars belong at object edges and expose object-level actions.
- Near/far transitions should be comfortable and predictable.

Implication: panel management controls should be object chrome, not random buttons inside the content surface.

### Android XR / Spatial Panels

Android XR explicitly treats spatial panels as fundamental building blocks. It recommends separate panels for separate multitasking surfaces, such as chat windows and lists. It also recommends dedicated panels or orbiters for menus/assets/controls instead of mixing those controls into the main editing panel.

Important Android XR patterns:

- Keep panels comfortable and legible as distance changes.
- Default panel depth guidance is roughly `0.75m` to `5m`.
- Spawn panels around `1.75m` from the user and slightly below eye level.
- Keep critical content in a comfortable center field of view.
- Avoid overlapping panels that block important information.

Implication: terminal, chat, agent status, editor/diff, and control surfaces should be separable panels, not permanently connected cards.

## Correct Panel Anatomy For XR Coding Agent

Each panel should have these zones:

1. Content surface
   - Terminal, chat, code, diff, worker status, browser preview, or logs.
   - Ray trigger/pinch activates controls or scrolls/selects content.
   - Should not move the panel unless in explicit panel-management mode.

2. Title / control bar
   - Panel title.
   - Drag affordance.
   - Close.
   - Minimize/collapse.
   - Pin/follow toggle.
   - Optional layout/reset/resize mode.
   - Grabbing this bar moves the panel.

3. Edge handles
   - Reveal on hover/focus.
   - Grabbing an edge repositions or reflows, depending on mode.
   - Edge handles prevent content interaction from conflicting with panel movement.

4. Corner handles
   - Reveal on hover/focus.
   - Grabbing a corner resizes the panel.
   - Resize should be centered or predictable, not random stretching.

5. Optional bottom manipulation bar
   - Matches Meta/Microsoft style object chrome.
   - Useful for panel-level actions without hiding content.

## Required Interaction State Machine

Panel interaction should follow this state machine:

1. Idle
   - Panel is world-locked.
   - No motion.

2. Hover / targeted
   - Ray/cursor/fingertip target appears.
   - Focus outline or handle reveal appears.
   - No spatial movement.

3. Press / select
   - Trigger/pinch/tap activates a button or content item.
   - Pressed visuals appear.
   - No panel movement unless the target was a handle/control bar.

4. Grab capture
   - On squeeze, select-hold, or direct grab of a control bar/edge/corner, latch:
     - input source id,
     - panel id,
     - hit zone,
     - panel world transform,
     - hit point in panel local space,
     - input pose/ray at start.

5. Drag / resize
   - Move only the captured panel.
   - Do not change other panels.
   - Do not switch targets mid-drag.
   - Keep motion kinematic and stable for UI panels.

6. Release
   - Persist panel position/scale/rotation.
   - Clear capture state.
   - Keep panel where the user placed it.

## Do / Don’t For Our Panels

Do:

- Make panels independent spatial windows.
- Use ray hover for focus and affordance reveal only.
- Use trigger/pinch for clicking buttons and content.
- Use squeeze/grab or select-hold on an explicit bar/edge/corner for movement.
- Add a visible cursor/reticle at the ray intersection point.
- Add title/control bars to every panel.
- Add edge and corner handles.
- Support direct touch for near controls, but keep ray input as the default comfortable path.
- Persist per-panel position, size, collapsed state, pinned/follow state, and last focused worker.
- Keep code and terminal text planar, stable, and readable.
- Use larger XR controls than desktop controls.
- Keep common panels inside a comfortable field of view and avoid forced recentering.

Don’t:

- Don’t move panels on hover.
- Don’t let the entire panel be draggable if that conflicts with scrolling or text interaction.
- Don’t bind all panels to one root transform unless the user explicitly grabs a group manipulation handle.
- Don’t make the deck follow the headset after placement.
- Don’t hide panel controls in a global bottom indicator.
- Don’t rely only on direct hand poke.
- Don’t put tiny desktop-sized buttons into XR.
- Don’t make controls hover-only with no visible explanation of what can be grabbed.
- Don’t recompute the dragged panel while a gesture is active.
- Don’t use head ray as the primary pointer except as fallback/debugging.

## Concrete Implementation Target

The XR Coding Agent panel system should become:

- `PanelManager`
  - owns a list of independent panel records.
  - stores transform, size, visibility, collapsed state, and pinned/follow state.

- `XRInputManager`
  - tracks active `XRInputSource`s.
  - normalizes controller trigger, controller squeeze, hand pinch, and direct fingertip touch.

- `PanelRaycaster`
  - raycasts against panel hit planes and chrome hit zones.
  - maps world hit points to panel-local coordinates.

- `PanelInteractionState`
  - tracks hover, press, drag capture, resize capture, and release per input source.

- `PanelTransformController`
  - moves/resizes only the captured panel.
  - persists transform on release.
  - supports group movement only through an explicit group handle.

- `CanvasPanelAdapter`
  - maps panel-local hit points into canvas UI actions.
  - handles scroll, tap, button activation, and focus.

## Priority Changes For This Repo

1. Add real panel chrome.
   - Title/control bar on each panel.
   - Close/minimize/pin/follow controls on the panel, not in a shared hidden area.

2. Split panel movement from content interaction.
   - Content tap/scroll should not drag the panel.
   - Only title/control bar, edge, corner, or explicit management mode moves/resizes.

3. Add handles.
   - Hover reveals edge handles and corner handles.
   - Handles have visible focus/pressed/drag states.

4. Add per-panel persistence.
   - Store transforms per panel.
   - Stop reapplying layout every frame after user placement.

5. Add direct-touch support.
   - Index fingertip poke for buttons/scrolling when panels are near.
   - Larger targets and touch limiting.

6. Add a layout reset and group handle.
   - Users need a safe way to reset the whole layout.
   - Group movement should be explicit and visually different from individual panel movement.

7. Expand panel set for actual coding.
   - Worker/terminal.
   - Hermes chat.
   - Task/status.
   - Diff/review.
   - File/context.
   - Preview/logs.

## Source Links

- Meta Horizon panels: https://developers.meta.com/horizon/design/panels/
- Meta Horizon windows: https://developers.meta.com/horizon/design/windows/
- Meta ray casting: https://developers.meta.com/horizon/design/raycasting_usage/
- Meta ray casting best practices: https://developers.meta.com/horizon/design/raycasting_bp/
- Meta touch best practices: https://developers.meta.com/horizon/design/touch_bp/
- Meta grab: https://developers.meta.com/horizon/design/grab_usage/
- Meta grab best practices: https://developers.meta.com/horizon/design/grab_bp/
- Meta Interaction SDK ray interactions: https://developers.meta.com/horizon/documentation/unity/unity-isdk-ray-interaction/
- W3C WebXR Device API: https://www.w3.org/TR/webxr/
- Immersive Web input explainer: https://immersive-web.github.io/webxr/input-explainer.html
- W3C WebXR Hand Input: https://www.w3.org/TR/webxr-hand-input-1/
- MDN WebXR permissions/security: https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Permissions_and_security
- Apple Vision Pro gestures: https://support.apple.com/en-gb/117741
- Apple visionOS windows: https://developer.apple.com/design/human-interface-guidelines/windows
- Microsoft Mixed Reality interactable object: https://learn.microsoft.com/en-us/windows/mixed-reality/design/interactable-object
- Microsoft point and commit: https://learn.microsoft.com/en-us/windows/mixed-reality/design/point-and-commit
- Microsoft slate: https://learn.microsoft.com/en-us/windows/mixed-reality/design/slate
- Microsoft bounding box and app bar: https://learn.microsoft.com/en-us/windows/mixed-reality/design/app-bar-and-bounding-box
- Android XR spatial UI: https://developer.android.com/design/ui/xr/guides/spatial-ui
- Android XR quality guidelines: https://developer.android.com/docs/quality-guidelines/android-xr
- Unity XR Ray Interactor: https://docs.unity.cn/Packages/com.unity.xr.interaction.toolkit%403.0/manual/xr-ray-interactor.html
- Unity XR UI raycaster: https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit%402.0/api/UnityEngine.XR.Interaction.Toolkit.UI.html
