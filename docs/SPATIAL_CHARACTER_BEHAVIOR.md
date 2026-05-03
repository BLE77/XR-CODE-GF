# Spatial Character Behavior

The character should not read raw Quest camera frames directly in the web app.
In WebXR, camera imagery is privacy-gated and usually not exposed as a normal
video stream. The browser can expose safer spatial signals instead: hit tests,
planes, depth/mesh data, anchors, and tracking poses. If we need semantic labels
like "chair", "couch", or "table", that should come from an explicit native or
companion-side perception pipeline with user permission.

## Runtime Loop

1. Observe the room.
   - WebXR hit tests and plane/mesh/depth data provide geometry.
   - Optional companion/native camera capture can provide semantic frames.

2. Convert observations into memory streams.
   - `xr_pose`: headset/controller pose over time.
   - `xr_planes`: detected horizontal/vertical surfaces.
   - `xr_mesh`: coarse room geometry or depth samples.
   - `vision_frame`: optional permissioned camera snapshots.
   - `affordance`: derived places where Yuki can stand, sit, lean, point, or
     avoid.

3. Derive affordances.
   - A low, mostly horizontal surface becomes a possible seat if it is around
     chair/couch height and has enough free volume above it.
   - A taller horizontal surface becomes a table/counter candidate.
   - A floor patch becomes a standing/walking placement target.
   - Occupancy inflation keeps Yuki away from walls, furniture edges, and the
     user's body.

4. Choose behavior.
   - `YukiBehaviorPlanner` owns the priority order for the Quest client.
   - Alert, listening, speaking, and manual placement states block new
     autonomous moves.
   - If Yuki is idle/ready/thinking and a seat candidate is stable for several
     seconds, she can move to it and use a sit pose.
   - If no stable seat is available, stable table-height surfaces become a
     standing/table focus for future point/lean behaviors.

## Dimos Memory Pattern

The linked Dimos memory doc is useful because it treats perception as streams:
store raw observations, transform them into derived streams, and query them
later. We can follow the same shape for XR:

- store room scans and poses over time
- downsample noisy streams
- derive occupancy and affordance maps
- optionally embed camera snapshots for semantic search
- query "best nearby seat" or "clear surface near user" when the character
  needs an autonomous action

## Boxer3D-Style Object Boxes

The Boxer3D repo is a good model for the semantic side of this system: camera
detections plus depth/LiDAR become 3D object boxes. That should run in a native
or companion process, then send compact detections into the XR client:

- `className`: chair, couch, table, desk, etc.
- `center`: 3D position in room coordinates
- `size`: 3D dimensions
- `yaw`: optional object orientation
- `confidence`: model confidence

The client-side affordance store can now consume these object boxes. Chair,
couch, bench, stool, and ottoman boxes become seat candidates; table, desk, and
counter boxes become table candidates. This keeps model-heavy vision out of the
Quest web app while still letting Yuki use semantic scene understanding.

## Current Implementation

The Meta Quest client now has:

- a `Place Yuki` button
- a `SpatialAffordanceStore` for floor, seat, table, and blocked candidates
- XR plane ingestion when `detectedPlanes` is available from the browser
- Boxer3D-style 3D object-box ingestion for companion/native perception
- manual-placement observations so placed surfaces become part of memory
- debug affordance rings in `?stageDebug=1`
- a `YukiBehaviorPlanner` that chooses between attention, manual placement,
  autonomous sitting, table-focus idle, and standing idle
- an autonomous seat behavior that lets Yuki sit on a stable low surface when
  conversation/alert/manual-placement priorities are not active

## Next Implementation Steps

1. Add a companion/native semantic labeling stream for object names like chair,
   couch, desk, or table.
2. Add user controls for whether autonomous sitting is allowed in each session.
3. Add more object interactions: point at a table, lean near a counter, avoid
   occupied areas.
4. Add persistence so stable room affordances survive app refreshes.
