import ARKit
import RealityKit
import SwiftUI
import UIKit

struct YukiARView: UIViewRepresentable {
    @ObservedObject var sceneModel: YukiARSceneModel
    @ObservedObject var client: YukiIOSClient

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> ARView {
        let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        context.coordinator.install(in: arView)
        context.coordinator.runSession(on: arView, sceneModel: sceneModel)
        return arView
    }

    func updateUIView(_ arView: ARView, context: Context) {
        context.coordinator.update(
            arView: arView,
            sceneModel: sceneModel,
            avatarPhase: client.avatarPhase
        )
    }

    static func dismantleUIView(_ arView: ARView, coordinator: Coordinator) {
        arView.session.pause()
    }

    @MainActor
    final class Coordinator {
        private weak var arView: ARView?
        private var yukiAnchor: AnchorEntity?
        private var yukiRoot: Entity?
        private var lastPlacementRequestID = -1
        private var lastAvatarPhase: YukiAvatarPhase = .idle

        func install(in arView: ARView) {
            self.arView = arView
            arView.renderOptions.insert(.disableMotionBlur)
        }

        func runSession(on arView: ARView, sceneModel: YukiARSceneModel) {
            guard ARWorldTrackingConfiguration.isSupported else {
                sceneModel.placementStatus = "ARKit world tracking unavailable"
                return
            }

            let configuration = ARWorldTrackingConfiguration()
            configuration.planeDetection = [.horizontal, .vertical]
            configuration.environmentTexturing = .automatic
            arView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
            sceneModel.placementStatus = "Move iPhone to map the room"
        }

        func update(arView: ARView, sceneModel: YukiARSceneModel, avatarPhase: YukiAvatarPhase) {
            if sceneModel.placementRequestID != lastPlacementRequestID {
                lastPlacementRequestID = sceneModel.placementRequestID
                placeYuki(in: arView, sceneModel: sceneModel)
            }

            if avatarPhase != lastAvatarPhase {
                lastAvatarPhase = avatarPhase
                applyPhase(avatarPhase)
            }
        }

        private func placeYuki(in arView: ARView, sceneModel: YukiARSceneModel) {
            guard let frame = arView.session.currentFrame else {
                sceneModel.placementStatus = "Camera pose not ready"
                return
            }

            let cameraTransform = frame.camera.transform
            let cameraPosition = SIMD3<Float>(
                cameraTransform.columns.3.x,
                cameraTransform.columns.3.y,
                cameraTransform.columns.3.z
            )

            let center = CGPoint(x: arView.bounds.midX, y: arView.bounds.midY)
            let raycastTarget = arView
                .raycast(from: center, allowing: .estimatedPlane, alignment: .horizontal)
                .first

            let target: SIMD3<Float>
            if let raycastTarget {
                target = SIMD3<Float>(
                    raycastTarget.worldTransform.columns.3.x,
                    raycastTarget.worldTransform.columns.3.y,
                    raycastTarget.worldTransform.columns.3.z
                )
                sceneModel.placementStatus = "Placed on tracked surface"
            } else {
                let rawForward = SIMD3<Float>(
                    -cameraTransform.columns.2.x,
                    0,
                    -cameraTransform.columns.2.z
                )
                let forward = simd_length(rawForward) > 0.001 ? simd_normalize(rawForward) : SIMD3<Float>(0, 0, -1)
                target = cameraPosition + (forward * 0.9) + SIMD3<Float>(0, -0.65, 0)
                sceneModel.placementStatus = "Placed in front of camera"
            }

            var transform = matrix_identity_float4x4
            transform.columns.3 = SIMD4<Float>(target.x, target.y, target.z, 1)

            let root = yukiRoot ?? makeFallbackYuki()
            if yukiRoot == nil {
                yukiRoot = root
            }

            if let anchor = yukiAnchor {
                anchor.setTransformMatrix(transform, relativeTo: nil)
            } else {
                let anchor = AnchorEntity(world: transform)
                anchor.addChild(root)
                arView.scene.addAnchor(anchor)
                yukiAnchor = anchor
            }

            root.look(at: cameraPosition, from: target, relativeTo: nil)
            applyPhase(lastAvatarPhase)
        }

        private func applyPhase(_ phase: YukiAvatarPhase) {
            guard let root = yukiRoot else {
                return
            }

            let scale: Float = phase == .speaking ? 1.08 : phase == .alert ? 1.04 : 1.0
            root.scale = SIMD3<Float>(repeating: scale)

            let material = SimpleMaterial(
                color: phase.materialColor,
                roughness: 0.42,
                isMetallic: false
            )

            root.visit { entity in
                guard var model = entity.components[ModelComponent.self] else {
                    return
                }
                model.materials = [material]
                entity.components.set(model)
            }
        }

        private func makeFallbackYuki() -> Entity {
            let root = Entity()
            root.name = "yuki-ios-placeholder-root"

            let body = ModelEntity(
                mesh: .generateBox(size: SIMD3<Float>(0.18, 0.42, 0.12)),
                materials: [SimpleMaterial(color: YukiAvatarPhase.idle.materialColor, roughness: 0.42, isMetallic: false)]
            )
            body.name = "yuki-body"
            body.position.y = 0.28

            let head = ModelEntity(
                mesh: .generateSphere(radius: 0.105),
                materials: [SimpleMaterial(color: YukiAvatarPhase.idle.materialColor, roughness: 0.42, isMetallic: false)]
            )
            head.name = "yuki-head"
            head.position.y = 0.56

            let face = ModelEntity(
                mesh: .generateBox(size: SIMD3<Float>(0.08, 0.025, 0.01)),
                materials: [SimpleMaterial(color: UIColor.white, roughness: 0.2, isMetallic: false)]
            )
            face.name = "yuki-face-marker"
            face.position = SIMD3<Float>(0, 0.57, -0.1)

            root.addChild(body)
            root.addChild(head)
            root.addChild(face)
            return root
        }
    }
}

private extension Entity {
    func visit(_ body: (Entity) -> Void) {
        body(self)
        for child in children {
            child.visit(body)
        }
    }
}

private extension YukiAvatarPhase {
    var materialColor: UIColor {
        switch self {
        case .idle:
            return UIColor(red: 0.42, green: 0.82, blue: 0.95, alpha: 1)
        case .listening:
            return UIColor(red: 0.98, green: 0.42, blue: 0.72, alpha: 1)
        case .thinking:
            return UIColor(red: 1.0, green: 0.66, blue: 0.24, alpha: 1)
        case .speaking:
            return UIColor(red: 0.34, green: 0.64, blue: 1.0, alpha: 1)
        case .alert:
            return UIColor(red: 1.0, green: 0.27, blue: 0.23, alpha: 1)
        case .ready:
            return UIColor(red: 0.28, green: 0.82, blue: 0.48, alpha: 1)
        }
    }
}
