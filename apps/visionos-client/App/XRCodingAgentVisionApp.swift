import ARKit
import Metal
import QuartzCore
import RealityKit
import SwiftUI

let assistantImmersiveSpaceID = "assistantImmersiveSpace"
let codingSessionWindowID = "codingSessionWindow"

@MainActor
final class SpatialAssistantSettings: ObservableObject {
    @Published var avatarScale: Float
    @Published var avatarLift: Float
    @Published var selectedModelName: String
    @Published var currentProjectPath: String
    @Published var isSpeaking = false
    @Published var isWandering = false
    @Published var avoidsFurniture = true
    @Published var facesUserWhenNearby = true
    @Published var matchesRoomLighting = true
    @Published var moveAvatarInFrontRequestID = 0
    @Published var sendCommandRequestID = 0
    @Published var idlePhase: Float = 0
    @Published var speechPhase: Float = 0

    private var idleTimer: Timer?
    private var speechTimer: Timer?

    init(selectedModelName: String = "vamp") {
        let model = ModelCatalog.model(named: selectedModelName)
        self.selectedModelName = selectedModelName
        self.avatarScale = Float(model.immersiveDefaultScale)
        self.avatarLift = Self.defaultLift(for: model)
        self.currentProjectPath = ""
        startIdleAnimation()
    }

    deinit {
        idleTimer?.invalidate()
        speechTimer?.invalidate()
    }

    func applyDefaultsForSelectedModel() {
        let model = ModelCatalog.model(named: selectedModelName)
        avatarScale = Float(model.immersiveDefaultScale)
        avatarLift = Self.defaultLift(for: model)
    }

    func requestMoveAvatarInFront() {
        moveAvatarInFrontRequestID += 1
    }

    func requestSendCurrentCommand() {
        sendCommandRequestID += 1
    }

    private static func defaultLift(for model: BundledModel) -> Float {
        #if targetEnvironment(simulator)
        return Float(model.immersiveLift)
        #else
        return 0
        #endif
    }

    private func startIdleAnimation() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor [weak self] in
                self?.idlePhase += 0.22
            }
        }
        if let idleTimer {
            RunLoop.main.add(idleTimer, forMode: .common)
        }
    }

    func startSpeakingAnimation() {
        isSpeaking = true
        speechTimer?.invalidate()
        speechTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor [weak self] in
                self?.speechPhase += 0.55
            }
        }
        if let speechTimer {
            RunLoop.main.add(speechTimer, forMode: .common)
        }
    }

    func stopSpeakingAnimation() {
        isSpeaking = false
        speechTimer?.invalidate()
        speechTimer = nil
        speechPhase = 0
    }
}

private struct ObstacleCell: Hashable {
    let x: Int
    let z: Int

    init(x: Int, z: Int) {
        self.x = x
        self.z = z
    }

    init(point: SIMD3<Float>, cellSize: Float) {
        x = Int(floor(point.x / cellSize))
        z = Int(floor(point.z / cellSize))
    }
}

@MainActor
private final class SpatialRoomRuntime: ObservableObject {
    private let cellSize: Float = 0.12
    private let obstacleHeightThreshold: Float = 0.18
    private let wanderRadius: Float = 0.85
    private let travelSpeed: Float = 0.26
    private let clearanceRadius: Float = 0.22
    private let lookaheadDistance: Float = 0.28

    var anchorTransform = matrix_identity_float4x4
    var obstacleCellsByAnchor: [UUID: Set<ObstacleCell>] = [:]
    var obstacleCells: Set<ObstacleCell> = []
    var walkOffset = SIMD2<Float>(0, 0)
    var walkTarget: SIMD2<Float>?
    var facingYaw: Float = 0
    var isMoving = false

    private var lastIdlePhase: Float?
    private var pauseRemaining: Float = 0.15

    func reset() {
        obstacleCellsByAnchor.removeAll()
        obstacleCells.removeAll()
        walkOffset = .zero
        walkTarget = nil
        facingYaw = 0
        isMoving = false
        lastIdlePhase = nil
        pauseRemaining = 0.15
        anchorTransform = matrix_identity_float4x4
    }

    func updateObstacleCells(for anchorID: UUID, cells: Set<ObstacleCell>) {
        if cells.isEmpty {
            obstacleCellsByAnchor.removeValue(forKey: anchorID)
        } else {
            obstacleCellsByAnchor[anchorID] = cells
        }
        obstacleCells = obstacleCellsByAnchor.values.reduce(into: Set<ObstacleCell>()) { result, cells in
            result.formUnion(cells)
        }
    }

    func removeObstacle(anchorID: UUID) {
        obstacleCellsByAnchor.removeValue(forKey: anchorID)
        obstacleCells = obstacleCellsByAnchor.values.reduce(into: Set<ObstacleCell>()) { result, cells in
            result.formUnion(cells)
        }
    }

    func advance(idlePhase: Float, wanderingEnabled: Bool, avoidanceEnabled: Bool) {
        let deltaTime: Float
        if let lastIdlePhase {
            let phaseDelta = max(idlePhase - lastIdlePhase, 0)
            deltaTime = max(0.016, (phaseDelta / 0.22) * 0.08)
        } else {
            deltaTime = 0.08
        }
        lastIdlePhase = idlePhase

        if !wanderingEnabled {
            walkTarget = nil
            pauseRemaining = 0
            isMoving = false
            return
        }

        if pauseRemaining > 0 {
            pauseRemaining = max(0, pauseRemaining - deltaTime)
            isMoving = false
            return
        }

        if walkTarget == nil || distance(walkOffset, walkTarget ?? .zero) < 0.05 {
            walkTarget = chooseTarget(avoidanceEnabled: avoidanceEnabled)
            if walkTarget == nil {
                pauseRemaining = 1.0
                isMoving = false
                return
            }
        }

        guard let walkTarget else {
            isMoving = false
            return
        }

        let delta = walkTarget - walkOffset
        let distanceToTarget = simd_length(delta)
        guard distanceToTarget > 0.001 else {
            self.walkTarget = nil
            pauseRemaining = 1.1
            isMoving = false
            return
        }

        let direction = delta / distanceToTarget
        let lookahead = walkOffset + (direction * lookaheadDistance)
        if avoidanceEnabled && isBlocked(lookahead) {
            self.walkTarget = nil
            pauseRemaining = 0.9
            isMoving = false
            return
        }

        let step = min(distanceToTarget, travelSpeed * deltaTime)
        let candidate = walkOffset + (direction * step)
        if avoidanceEnabled && isBlocked(candidate) {
            self.walkTarget = nil
            pauseRemaining = 0.9
            isMoving = false
            return
        }

        walkOffset = candidate
        facingYaw = atan2(direction.x, direction.y)
        isMoving = step > 0.0001

        if simd_distance(candidate, walkTarget) < 0.05 {
            self.walkTarget = nil
            pauseRemaining = Float.random(in: 1.1...2.2)
            isMoving = false
        }
    }

    func faceUserIfNearby(userPosition: SIMD3<Float>, maximumDistance: Float = 1.4) {
        let avatarPosition = SIMD3<Float>(walkOffset.x, 0, walkOffset.y)
        let horizontalDelta = SIMD2<Float>(userPosition.x - avatarPosition.x, userPosition.z - avatarPosition.z)
        let distanceToUser = simd_length(horizontalDelta)

        guard distanceToUser > 0.08, distanceToUser <= maximumDistance else {
            return
        }

        facingYaw = atan2(horizontalDelta.x, horizontalDelta.y)
    }

    private func chooseTarget(avoidanceEnabled: Bool) -> SIMD2<Float>? {
        for _ in 0..<18 {
            let angle = Float.random(in: -Float.pi...Float.pi)
            let radius = Float.random(in: 0.2...0.75)
            let candidate = walkOffset + SIMD2<Float>(sin(angle), cos(angle)) * radius
            if simd_length(candidate) > wanderRadius {
                continue
            }
            if avoidanceEnabled && isBlocked(candidate) {
                continue
            }
            return candidate
        }

        return nil
    }

    private func isBlocked(_ point: SIMD2<Float>) -> Bool {
        let cellRadius = Int(ceil(clearanceRadius / cellSize))
        let centerCell = ObstacleCell(point: SIMD3<Float>(point.x, 0, point.y), cellSize: cellSize)

        for xOffset in -cellRadius...cellRadius {
            for zOffset in -cellRadius...cellRadius {
                let candidate = ObstacleCell(x: centerCell.x + xOffset, z: centerCell.z + zOffset)
                if obstacleCells.contains(candidate) {
                    return true
                }
            }
        }

        return false
    }

    func obstacleCells(for meshAnchor: MeshAnchor) -> Set<ObstacleCell> {
        let geometry = meshAnchor.geometry
        guard geometry.vertices.count > 0 else {
            return []
        }

        let anchorFromWorld = simd_inverse(anchorTransform)
        let worldFromMesh = meshAnchor.originFromAnchorTransform
        let rawVertices = geometry.vertices.buffer.contents()
        var occupied = Set<ObstacleCell>()

        for index in stride(from: 0, to: geometry.vertices.count, by: 4) {
            let pointer = rawVertices.advanced(by: geometry.vertices.offset + (geometry.vertices.stride * index))
            let localVertex = pointer.assumingMemoryBound(to: SIMD3<Float>.self).pointee
            let worldVertex = worldFromMesh * SIMD4<Float>(localVertex.x, localVertex.y, localVertex.z, 1)
            let anchorLocalVertex = anchorFromWorld * worldVertex
            let point = SIMD3<Float>(anchorLocalVertex.x, anchorLocalVertex.y, anchorLocalVertex.z)

            guard point.y > obstacleHeightThreshold, point.y < 1.9 else {
                continue
            }

            occupied.insert(ObstacleCell(point: point, cellSize: cellSize))
        }

        return occupied
    }
}

@main
struct XRCodingAgentVisionApp: App {
    @StateObject private var spatialSettings = SpatialAssistantSettings()
    @StateObject private var eventClient = EventStreamClient()
    @StateObject private var voiceManager = VoiceControlManager()

    var body: some SwiftUI.Scene {
        WindowGroup {
            ContentView()
                .environmentObject(spatialSettings)
                .environmentObject(eventClient)
                .environmentObject(voiceManager)
        }
        .windowStyle(.plain)
        .defaultSize(width: 1200, height: 900)

        WindowGroup(id: codingSessionWindowID, for: String.self) { $sessionID in
            if let sessionID, !sessionID.isEmpty {
                TerminalSessionWindowView(sessionID: sessionID)
                    .environmentObject(eventClient)
                    .environmentObject(voiceManager)
                    .environmentObject(spatialSettings)
            } else {
                Text("Open a coding session first.")
                    .padding(40)
            }
        }
        .windowStyle(.plain)
        .defaultSize(width: 960, height: 700)

        ImmersiveSpace(id: assistantImmersiveSpaceID) {
            SpatialAssistantImmersiveView()
                .environmentObject(spatialSettings)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}

private struct SpatialAssistantImmersiveView: View {
    @EnvironmentObject private var spatialSettings: SpatialAssistantSettings
    @StateObject private var roomRuntime = SpatialRoomRuntime()
    @State private var trackingSession = SpatialTrackingSession()
    @State private var arSession = ARKitSession()
    @State private var sceneReconstruction = SceneReconstructionProvider()
    @State private var worldTracking = WorldTrackingProvider()
    @State private var handTracking = HandTrackingProvider()
    @State private var lastMoveAvatarRequestID = 0
    @State private var lastThumbsUpSendAt = Date.distantPast

    var body: some View {
        RealityView { content in
            let anchor = makeAssistantAnchor()
            let lightRig = makeLightRig(matchesRoomLighting: spatialSettings.matchesRoomLighting)
            lightRig.name = "assistant-light-rig"
            anchor.addChild(lightRig)
            let avatarRoot = loadAssistantEntity()
            avatarRoot.name = "assistant-avatar-root"
            avatarRoot.scale = SIMD3<Float>(repeating: spatialSettings.avatarScale)
            avatarRoot.position.y = spatialSettings.avatarLift
            configureLighting(for: avatarRoot, matchesRoomLighting: spatialSettings.matchesRoomLighting)
            anchor.addChild(avatarRoot)
            content.add(anchor)
        } update: { content in
            if let sceneAnchor = content.entities.first as? AnchorEntity {
                roomRuntime.anchorTransform = sceneAnchor.transformMatrix(relativeTo: nil)
                if let lightRig = sceneAnchor.findEntity(named: "assistant-light-rig") {
                    updateLightRig(lightRig, matchesRoomLighting: spatialSettings.matchesRoomLighting)
                }
            }

            roomRuntime.advance(
                idlePhase: spatialSettings.idlePhase,
                wanderingEnabled: spatialSettings.isWandering,
                avoidanceEnabled: spatialSettings.avoidsFurniture
            )

            if
                spatialSettings.facesUserWhenNearby,
                !roomRuntime.isMoving,
                let userPose = currentUserPoseInAnchorSpace()
            {
                roomRuntime.faceUserIfNearby(userPosition: userPose.position)
            }

            if spatialSettings.moveAvatarInFrontRequestID != lastMoveAvatarRequestID {
                lastMoveAvatarRequestID = spatialSettings.moveAvatarInFrontRequestID
                if let userPose = currentUserPoseInAnchorSpace() {
                    moveAvatarInFrontOfUser(userPose: userPose)
                }
            }

            if detectThumbsUpSendGesture() {
                spatialSettings.requestSendCurrentCommand()
            }

            if let avatarRoot = content.entities.first?.findEntity(named: "assistant-avatar-root") {
                configureLighting(for: avatarRoot, matchesRoomLighting: spatialSettings.matchesRoomLighting)
                avatarRoot.scale = SIMD3<Float>(repeating: spatialSettings.avatarScale)
                let motionPhase = Int(abs(spatialSettings.idlePhase * 3.6))
                AvatarEntityFactory.updateMotionVariant(on: avatarRoot, isMoving: roomRuntime.isMoving, motionPhase: motionPhase)
                let idleBob: Float = 0
                let speakingBob = spatialSettings.isSpeaking ? (sinf(spatialSettings.speechPhase * 0.7) * 0.006) : 0
                avatarRoot.position.x = roomRuntime.walkOffset.x
                avatarRoot.position.z = roomRuntime.walkOffset.y
                avatarRoot.position.y = spatialSettings.avatarLift + idleBob + speakingBob
                let swayAngle = sinf(spatialSettings.idlePhase * 0.28) * 0.06
                avatarRoot.orientation = simd_quatf(angle: roomRuntime.facingYaw + swayAngle, axis: [0, 1, 0])
                if let blendEntity = avatarRoot.findEntity(named: "assistant-blendshape-driver") {
                    AvatarEntityFactory.applyFacialAnimation(
                        to: blendEntity,
                        isSpeaking: spatialSettings.isSpeaking,
                        speechPhase: spatialSettings.speechPhase,
                        idlePhase: spatialSettings.idlePhase
                    )
                }
            }
        }
        .id(spatialSettings.selectedModelName)
        .task {
            #if !targetEnvironment(simulator)
            _ = await trackingSession.run(.init(tracking: [.plane]))
            await startWorldSensing()
            #endif
        }
        .onDisappear {
            roomRuntime.reset()
        }
    }

    private func makeAssistantAnchor() -> AnchorEntity {
        #if targetEnvironment(simulator)
        var transform = matrix_identity_float4x4
        transform.columns.3 = SIMD4<Float>(0, -0.45, -0.9, 1)
        return AnchorEntity(.world(transform: transform))
        #else
        return AnchorEntity(plane: .horizontal, classification: .floor, minimumBounds: SIMD2<Float>(repeating: 0.6))
        #endif
    }

    private func makeLightRig(matchesRoomLighting: Bool) -> Entity {
        let lightRig = Entity()

        let keyLight = DirectionalLight()
        keyLight.name = "assistant-key-light"
        keyLight.position = [0.6, 1.6, 1.2]
        keyLight.look(at: [0, 0.9, 0], from: keyLight.position, relativeTo: nil)
        lightRig.addChild(keyLight)

        let fillLight = PointLight()
        fillLight.name = "assistant-fill-light"
        fillLight.position = [-0.8, 1.1, 0.9]
        lightRig.addChild(fillLight)

        let rimLight = SpotLight()
        rimLight.name = "assistant-rim-light"
        rimLight.position = [0, 1.8, -1.6]
        rimLight.look(at: [0, 0.85, 0], from: rimLight.position, relativeTo: nil)
        lightRig.addChild(rimLight)

        updateLightRig(lightRig, matchesRoomLighting: matchesRoomLighting)
        return lightRig
    }

    private func updateLightRig(_ lightRig: Entity, matchesRoomLighting: Bool) {
        let roomMatchedIntensityScale: Float = matchesRoomLighting ? 0.2 : 1.0

        if let keyLight = lightRig.findEntity(named: "assistant-key-light") as? DirectionalLight {
            keyLight.light.__color = CGColor(
                red: 1.0,
                green: 0.95,
                blue: 0.88,
                alpha: 1
            )
            #if targetEnvironment(simulator)
            keyLight.light.intensity = 7_200 * roomMatchedIntensityScale
            #else
            keyLight.light.intensity = 5_200 * roomMatchedIntensityScale
            #endif
        }

        if let fillLight = lightRig.findEntity(named: "assistant-fill-light") as? PointLight {
            fillLight.light.__color = CGColor(
                red: 0.82,
                green: 0.88,
                blue: 1.0,
                alpha: 1
            )
            fillLight.light.attenuationRadius = 4.4
            #if targetEnvironment(simulator)
            fillLight.light.intensity = 1_650 * roomMatchedIntensityScale
            #else
            fillLight.light.intensity = 850 * roomMatchedIntensityScale
            #endif
        }

        if let rimLight = lightRig.findEntity(named: "assistant-rim-light") as? SpotLight {
            rimLight.light.__color = CGColor(
                red: 1.0,
                green: 0.9,
                blue: 0.84,
                alpha: 1
            )
            rimLight.light.innerAngleInDegrees = 30
            rimLight.light.outerAngleInDegrees = 76
            rimLight.light.attenuationRadius = 5.4
            #if targetEnvironment(simulator)
            rimLight.light.intensity = 1_100 * roomMatchedIntensityScale
            #else
            rimLight.light.intensity = 650 * roomMatchedIntensityScale
            #endif
        }
    }

    private func configureLighting(for avatarRoot: Entity, matchesRoomLighting: Bool) {
        let lightingWeight: Float = matchesRoomLighting ? 1.0 : 0.1
        applyEnvironmentLightingRecursively(to: avatarRoot, weight: lightingWeight)
    }

    private func applyEnvironmentLightingRecursively(to entity: Entity, weight: Float) {
        entity.components.set(
            EnvironmentLightingConfigurationComponent(
                environmentLightingWeight: weight
            )
        )
        for child in entity.children {
            applyEnvironmentLightingRecursively(to: child, weight: weight)
        }
    }

    private func loadAssistantEntity() -> Entity {
        AvatarEntityFactory.makeImmersiveAvatar(named: spatialSettings.selectedModelName)
    }

    private func currentUserPoseInAnchorSpace() -> (position: SIMD3<Float>, forward: SIMD3<Float>)? {
        #if targetEnvironment(simulator)
        nil
        #else
        guard let deviceAnchor = worldTracking.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()), deviceAnchor.isTracked else {
            return nil
        }

        let deviceTransform = deviceAnchor.originFromAnchorTransform
        let deviceWorldPosition = deviceTransform.columns.3
        let anchorFromWorld = simd_inverse(roomRuntime.anchorTransform)
        let anchorLocalPosition = anchorFromWorld * SIMD4<Float>(deviceWorldPosition.x, deviceWorldPosition.y, deviceWorldPosition.z, 1)
        let anchorLocalTransform = anchorFromWorld * deviceTransform
        let rawForward = SIMD3<Float>(
            -anchorLocalTransform.columns.2.x,
            0,
            -anchorLocalTransform.columns.2.z
        )
        let normalizedForward = simd_length(rawForward) > 0.001 ? simd_normalize(rawForward) : SIMD3<Float>(0, 0, -1)
        return (
            SIMD3<Float>(anchorLocalPosition.x, anchorLocalPosition.y, anchorLocalPosition.z),
            normalizedForward
        )
        #endif
    }

    private func moveAvatarInFrontOfUser(userPose: (position: SIMD3<Float>, forward: SIMD3<Float>)) {
        let targetDistance: Float = 0.9
        let target = userPose.position + (userPose.forward * targetDistance)
        roomRuntime.walkOffset = SIMD2<Float>(target.x, target.z)
        roomRuntime.walkTarget = nil
        roomRuntime.isMoving = false
        roomRuntime.facingYaw = atan2(-userPose.forward.x, -userPose.forward.z)
    }

    private func startWorldSensing() async {
        guard SceneReconstructionProvider.isSupported else {
            return
        }

        _ = await arSession.requestAuthorization(for: [.worldSensing])

        do {
            if HandTrackingProvider.isSupported {
                try await arSession.run([sceneReconstruction, worldTracking, handTracking])
            } else {
                try await arSession.run([sceneReconstruction, worldTracking])
            }
            for await update in sceneReconstruction.anchorUpdates {
                switch update.event {
                case .added, .updated:
                    let cells = roomRuntime.obstacleCells(for: update.anchor)
                    roomRuntime.updateObstacleCells(for: update.anchor.id, cells: cells)
                case .removed:
                    roomRuntime.removeObstacle(anchorID: update.anchor.id)
                }
            }
        } catch {
            roomRuntime.reset()
        }
    }

    private func detectThumbsUpSendGesture() -> Bool {
        #if targetEnvironment(simulator)
        false
        #else
        let now = Date()
        guard now.timeIntervalSince(lastThumbsUpSendAt) > 1.6 else {
            return false
        }

        let hands = handTracking.handAnchors(at: CACurrentMediaTime())
        if let leftHand = hands.leftHand, isThumbsUp(hand: leftHand) {
            lastThumbsUpSendAt = now
            return true
        }
        if let rightHand = hands.rightHand, isThumbsUp(hand: rightHand) {
            lastThumbsUpSendAt = now
            return true
        }
        return false
        #endif
    }

    private func isThumbsUp(hand: HandAnchor) -> Bool {
        guard hand.isTracked, let skeleton = hand.handSkeleton else {
            return false
        }

        func worldPosition(_ jointName: HandSkeleton.JointName) -> SIMD3<Float>? {
            let joint = skeleton.joint(jointName)
            guard joint.isTracked else {
                return nil
            }
            let worldTransform = hand.originFromAnchorTransform * joint.anchorFromJointTransform
            return SIMD3<Float>(worldTransform.columns.3.x, worldTransform.columns.3.y, worldTransform.columns.3.z)
        }

        guard
            let wrist = worldPosition(.wrist),
            let thumbTip = worldPosition(.thumbTip),
            let thumbKnuckle = worldPosition(.thumbKnuckle),
            let indexTip = worldPosition(.indexFingerTip),
            let indexKnuckle = worldPosition(.indexFingerKnuckle),
            let middleTip = worldPosition(.middleFingerTip),
            let middleKnuckle = worldPosition(.middleFingerKnuckle),
            let ringTip = worldPosition(.ringFingerTip),
            let ringKnuckle = worldPosition(.ringFingerKnuckle),
            let littleTip = worldPosition(.littleFingerTip),
            let littleKnuckle = worldPosition(.littleFingerKnuckle)
        else {
            return false
        }

        let thumbRaised = thumbTip.y > thumbKnuckle.y + 0.025 && thumbTip.y > wrist.y + 0.05
        let fingersCurled =
            indexTip.y < indexKnuckle.y + 0.015 &&
            middleTip.y < middleKnuckle.y + 0.015 &&
            ringTip.y < ringKnuckle.y + 0.015 &&
            littleTip.y < littleKnuckle.y + 0.015
        let thumbSeparated = simd_distance(thumbTip, indexTip) > 0.05

        return thumbRaised && fingersCurled && thumbSeparated
    }
}
