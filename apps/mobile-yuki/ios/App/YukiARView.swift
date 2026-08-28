import ARKit
import GLTFKit2
import SceneKit
import SwiftUI
import UIKit

struct YukiARView: UIViewRepresentable {
    @ObservedObject var sceneModel: YukiARSceneModel
    @ObservedObject var client: YukiIOSClient

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        context.coordinator.install(in: view, sceneModel: sceneModel)
        context.coordinator.runSession(on: view)
        context.coordinator.loadYuki()
        return view
    }

    func updateUIView(_ view: ARSCNView, context: Context) {
        context.coordinator.update(
            sceneModel: sceneModel,
            placementRequestID: sceneModel.placementRequestID,
            avatarPhase: client.avatarPhase
        )
    }

    static func dismantleUIView(_ view: ARSCNView, coordinator: Coordinator) {
        coordinator.stop()
        view.session.pause()
    }

    @MainActor
    final class Coordinator: NSObject, ARSCNViewDelegate {
        private weak var view: ARSCNView?
        private weak var sceneModel: YukiARSceneModel?
        private var sceneSource: GLTFSCNSceneSource?
        private var yukiRoot: SCNNode?
        private var motionRoot: SCNNode?
        private var trackedAnchor: ARAnchor?
        private weak var trackedAnchorNode: SCNNode?
        private var lastPlacementRequestID = -1
        private var avatarPhase: YukiAvatarPhase = .idle
        private var phaseStartedAt: TimeInterval = 0
        private var modelStartedLoading = false
        private var lastSurfaceAvailable: Bool?
        private var bones: [String: SCNNode] = [:]
        private var restOrientations: [String: simd_quatf] = [:]
        private var faceMorphers: [SCNMorpher] = []
        private var animationPlayers: [String: SCNAnimationPlayer] = [:]
        private let placementReticle = SCNNode()
        private let targetHeight: Float = 0.68

        func install(in view: ARSCNView, sceneModel: YukiARSceneModel) {
            self.view = view
            self.sceneModel = sceneModel
            view.delegate = self
            view.scene = SCNScene()
            view.automaticallyUpdatesLighting = true
            view.autoenablesDefaultLighting = false
            view.antialiasingMode = .multisampling4X
            view.preferredFramesPerSecond = 60

            let ring = SCNTorus(ringRadius: 0.075, pipeRadius: 0.0035)
            let material = SCNMaterial()
            material.diffuse.contents = UIColor.systemCyan
            material.emission.contents = UIColor.systemCyan.withAlphaComponent(0.75)
            material.lightingModel = .constant
            ring.materials = [material]
            placementReticle.geometry = ring
            placementReticle.opacity = 0
            view.scene.rootNode.addChildNode(placementReticle)
        }

        func runSession(on view: ARSCNView) {
            guard ARWorldTrackingConfiguration.isSupported else {
                sceneModel?.placementStatus = "ARKit world tracking unavailable"
                return
            }
            let configuration = ARWorldTrackingConfiguration()
            configuration.planeDetection = [.horizontal, .vertical]
            configuration.environmentTexturing = .automatic
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
                configuration.frameSemantics.insert(.sceneDepth)
            }
            view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
            sceneModel?.placementStatus = "Loading Yuki · move iPhone across the floor"
        }

        func loadYuki() {
            guard !modelStartedLoading else { return }
            modelStartedLoading = true
            guard let url = Bundle.main.url(forResource: "YukiAnimated", withExtension: "glb", subdirectory: "Models")
                ?? Bundle.main.url(forResource: "YukiAnimated", withExtension: "glb")
                ?? Bundle.main.url(forResource: "Yuki", withExtension: "glb", subdirectory: "Models")
                ?? Bundle.main.url(forResource: "Yuki", withExtension: "glb")
            else {
                sceneModel?.placementStatus = "Yuki.glb is missing from the app bundle"
                return
            }

            GLTFAsset.load(with: url, options: [:]) { [weak self] _, status, asset, error, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if status == .complete, let asset {
                        self.prepareYuki(from: asset)
                    } else if let error {
                        self.sceneModel?.placementStatus = "Yuki failed to load: \(error.localizedDescription)"
                    }
                }
            }
        }

        func update(
            sceneModel: YukiARSceneModel,
            placementRequestID: Int,
            avatarPhase: YukiAvatarPhase
        ) {
            self.sceneModel = sceneModel
            if placementRequestID != lastPlacementRequestID {
                lastPlacementRequestID = placementRequestID
                placeYuki()
            }
            if avatarPhase != self.avatarPhase {
                self.avatarPhase = avatarPhase
                phaseStartedAt = CACurrentMediaTime()
            }
        }

        func stop() {
            placementReticle.removeFromParentNode()
        }

        private func prepareYuki(from asset: GLTFAsset) {
            let source = GLTFSCNSceneSource(asset: asset)
            guard let imported = source.defaultScene?.rootNode else {
                sceneModel?.placementStatus = "Yuki.glb contained no SceneKit scene"
                return
            }
            sceneSource = source

            let model = SCNNode()
            for child in imported.childNodes {
                model.addChildNode(child)
            }
            let (minimum, maximum) = model.boundingBox
            let height = max(maximum.y - minimum.y, 0.001)
            let scale = targetHeight / height
            model.simdScale = SIMD3<Float>(repeating: scale)
            model.simdPosition.y = -minimum.y * scale

            let motion = SCNNode()
            motion.name = "yuki-motion-root"
            motion.addChildNode(model)
            motion.isHidden = true
            yukiRoot = model
            motionRoot = motion

            collectRigNodes(in: model)
            configureAnimations(source.animations, on: model)
            trackedAnchorNode?.addChildNode(motion)
            motion.isHidden = trackedAnchorNode == nil
            sceneModel?.placementStatus = trackedAnchor == nil
                ? "Yuki loaded · aim at the floor and tap Place"
                : "Yuki loaded and anchored in the room"
        }

        private func collectRigNodes(in root: SCNNode) {
            bones.removeAll()
            restOrientations.removeAll()
            faceMorphers.removeAll()
            var meshCount = 0
            root.enumerateChildNodes { [weak self] node, _ in
                guard let self else { return }
                if let name = node.name, name.hasPrefix("J_Bip_") {
                    self.bones[name] = node
                    self.restOrientations[name] = node.simdOrientation
                }
                if let morpher = node.morpher {
                    self.faceMorphers.append(morpher)
                }
                if let geometry = node.geometry {
                    meshCount += 1
                    for material in geometry.materials {
                        material.isDoubleSided = true
                    }
                }
            }
            let faceMorphCount = faceMorphers.map(\.targets.count).max() ?? 0
            print("MOBILE_YUKI_MODEL_READY meshes=\(meshCount) bones=\(bones.count) faceMorphs=\(faceMorphCount) clips=\(animationPlayers.count)")
        }

        private func configureAnimations(_ animations: [GLTFSCNAnimation], on model: SCNNode) {
            animationPlayers.removeAll()
            let looping = Set([
                "neutral_idle", "curiosity", "confusion", "talk_gesture",
                "walk_forward", "seated_idle",
            ])
            for clip in animations {
                let player = clip.animationPlayer
                player.animation.usesSceneTimeBase = false
                player.animation.repeatCount = looping.contains(clip.name) ? .greatestFiniteMagnitude : 1
                model.addAnimationPlayer(player, forKey: clip.name)
                animationPlayers[clip.name] = player
                player.stop()
            }
            print("MOBILE_YUKI_ANIMATIONS_READY count=\(animationPlayers.count) retargetedPlayback=false names=\(animationPlayers.keys.sorted().joined(separator: ","))")
        }

        private func placeYuki() {
            guard let view else { return }
            guard let result = floorHit(in: view) else {
                sceneModel?.placementStatus = "No floor yet · move slowly across a textured surface"
                return
            }

            if let trackedAnchor {
                view.session.remove(anchor: trackedAnchor)
            }
            let anchor = ARAnchor(name: "mobile-yuki-world-anchor", transform: result.worldTransform)
            trackedAnchor = anchor
            trackedAnchorNode = nil
            view.session.add(anchor: anchor)
            sceneModel?.placementStatus = "Placing Yuki on tracked floor…"
        }

        private func floorHit(in view: ARSCNView) -> ARRaycastResult? {
            let center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
            guard let query = view.raycastQuery(
                from: center,
                allowing: .estimatedPlane,
                alignment: .horizontal
            ) else {
                return nil
            }
            return view.session.raycast(query).first
        }

        private func updateReticle(in view: ARSCNView) {
            guard trackedAnchor == nil, let result = floorHit(in: view) else {
                placementReticle.opacity = 0
                if trackedAnchor == nil, lastSurfaceAvailable != false {
                    lastSurfaceAvailable = false
                    sceneModel?.placementStatus = yukiRoot == nil
                        ? "Loading Yuki · move iPhone across the floor"
                        : "Move slowly until the cyan floor ring appears"
                }
                return
            }
            placementReticle.simdWorldTransform = result.worldTransform
            placementReticle.opacity = 0.9
            if lastSurfaceAvailable != true {
                lastSurfaceAvailable = true
                sceneModel?.placementStatus = yukiRoot == nil
                    ? "Floor found · Yuki is still loading"
                    : "Floor found · tap Place"
            }
        }

        func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
            guard let view else { return }
            updateReticle(in: view)
            animateYuki(at: time)
        }

        func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
            guard anchor.identifier == trackedAnchor?.identifier else { return }
            trackedAnchorNode = node
            if let motionRoot {
                node.addChildNode(motionRoot)
                motionRoot.isHidden = false
                faceYukiTowardCamera()
                sceneModel?.placementStatus = "Yuki is anchored on the tracked floor"
            } else {
                sceneModel?.placementStatus = "Floor anchored · waiting for Yuki model"
            }
            placementReticle.opacity = 0
        }

        func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
            switch camera.trackingState {
            case .normal:
                break
            case .notAvailable:
                sceneModel?.placementStatus = "AR tracking unavailable"
            case .limited(let reason):
                if trackedAnchor == nil {
                    sceneModel?.placementStatus = "Tracking limited: \(trackingReason(reason))"
                }
            }
        }

        private func faceYukiTowardCamera() {
            guard let view, let motionRoot, let frame = view.session.currentFrame else { return }
            let camera = frame.camera.transform.columns.3
            let world = motionRoot.simdWorldPosition
            let dx = camera.x - world.x
            let dz = camera.z - world.z
            motionRoot.simdEulerAngles.y = atan2(dx, dz)
        }

        private func animateYuki(at time: TimeInterval) {
            guard let motionRoot, !motionRoot.isHidden else { return }
            let t = Float(time - phaseStartedAt)

            // Keep the avatar's floor anchor invariant. Idle motion belongs in the
            // upper body so neither foot lifts or slides relative to the AR floor.
            motionRoot.simdPosition.y = 0
            motionRoot.simdEulerAngles.z = 0

            let listening = avatarPhase == .listening
            let thinking = avatarPhase == .thinking
            let speaking = avatarPhase == .speaking
            let alert = avatarPhase == .alert
            let isGroundedIdle = avatarPhase == .idle || avatarPhase == .ready
            let breathingSway = isGroundedIdle ? sin(t * 0.9) * 0.006 : 0
            let idleSway: Float = 0

            applyPose(
                "J_Bip_C_UpperChest",
                x: breathingSway,
                z: breathingSway * 0.35
            )
            let talkLeft = speaking ? sin(t * 3.2) * 0.16 : 0
            let talkRight = speaking ? sin(t * 3.2 + 1.4) * 0.18 : 0

            applyPose(
                "J_Bip_L_UpperArm",
                x: speaking ? -0.08 : 0,
                z: -1.12 + idleSway + talkLeft
            )
            applyPose(
                "J_Bip_R_UpperArm",
                x: alert ? -0.45 : speaking ? -0.10 : 0,
                z: alert ? 0.48 : 1.12 - idleSway + talkRight
            )
            applyPose(
                "J_Bip_L_LowerArm",
                x: speaking ? -0.18 + sin(t * 2.6) * 0.10 : 0,
                z: -0.10
            )
            applyPose(
                "J_Bip_R_LowerArm",
                x: alert ? -0.35 + sin(t * 5.0) * 0.18 : speaking ? -0.20 + sin(t * 2.8) * 0.12 : thinking ? -0.42 : 0,
                z: thinking ? -0.38 : 0.10
            )
            applyPose(
                "J_Bip_C_Head",
                x: listening ? -0.10 : thinking ? 0.06 : isGroundedIdle ? 0 : sin(t * 0.8) * 0.025,
                z: listening ? -0.09 : thinking ? 0.07 : 0
            )

            let blink = pow(max(0, sin(t * 0.78 - 1.35)), 28)
            for morpher in faceMorphers {
                morpher.setWeight(CGFloat(blink), forTargetNamed: "Fcl_EYE_Close")
                morpher.setWeight(CGFloat(speaking ? 0.2 + abs(sin(t * 8.0)) * 0.5 : 0), forTargetNamed: "Fcl_MTH_A")
                morpher.setWeight(CGFloat(speaking ? abs(sin(t * 6.1 + 0.8)) * 0.35 : 0), forTargetNamed: "Fcl_MTH_O")
                morpher.setWeight(CGFloat(listening ? 0.18 : 0), forTargetNamed: "Fcl_ALL_Joy")
            }
        }

        private func applyPose(_ boneName: String, x: Float = 0, y: Float = 0, z: Float = 0) {
            guard let bone = bones[boneName], let rest = restOrientations[boneName] else { return }
            let xRotation = simd_quatf(angle: x, axis: SIMD3<Float>(1, 0, 0))
            let yRotation = simd_quatf(angle: y, axis: SIMD3<Float>(0, 1, 0))
            let zRotation = simd_quatf(angle: z, axis: SIMD3<Float>(0, 0, 1))
            bone.simdOrientation = simd_normalize(rest * zRotation * yRotation * xRotation)
        }

        private func trackingReason(_ reason: ARCamera.TrackingState.Reason) -> String {
            switch reason {
            case .initializing: return "initializing"
            case .excessiveMotion: return "move the phone more slowly"
            case .insufficientFeatures: return "point at a textured, well-lit surface"
            case .relocalizing: return "relocalizing"
            @unknown default: return "unknown reason"
            }
        }
    }
}
